import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  defaultProviderAuthContext,
  type AuthContext,
  type ProviderEnv,
} from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  ModelRuntime,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const MISE_CONFIG_FILES = ["mise.toml", ".mise.toml", ".tool-versions"];
const MISE_TIMEOUT_MS = 10_000;
const MISE_MAX_BUFFER = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface ProjectEnvironmentContext {
  readonly cwd: string;
  getEnvironment(): NodeJS.ProcessEnv;
  getManagedEnvironment(): Record<string, string>;
  reload(): Promise<void>;
}

type RuntimeModels = {
  authContext?: AuthContext;
};

type RequestOptions = {
  env?: ProviderEnv;
  [key: string]: unknown;
};

type RuntimeInternals = {
  models?: RuntimeModels;
  prepareRequest?: (model: unknown, options?: RequestOptions) => Promise<unknown>;
};

type ProjectEnvironmentSnapshot = {
  environment: NodeJS.ProcessEnv;
  managedEnvironment: Record<string, string>;
};

type RuntimeBinding = {
  refresh(): Promise<void>;
};

const runtimeBindings = new WeakMap<ModelRuntime, RuntimeBinding>();
const NON_API_KEY_ENV_NAMES = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function configInDirectory(dir: string): boolean {
  return MISE_CONFIG_FILES.some((file) => existsSync(join(dir, file)));
}

/** Find the nearest mise configuration directory without invoking mise. */
export function findNearestMiseConfigDir(startCwd: string): string | undefined {
  let dir = resolve(startCwd);
  while (true) {
    if (configInDirectory(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parse the JSON object emitted by `mise env --json`. */
export function parseMiseEnvironment(output: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("mise returned invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("mise returned a non-object environment");

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}

async function runMise(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  const result = await execFileAsync("mise", args, {
    cwd,
    env: environment,
    timeout: MISE_TIMEOUT_MS,
    maxBuffer: MISE_MAX_BUFFER,
  });
  return { stdout: result.stdout };
}

/**
 * Resolve the environment that a mise-activated shell would use for a project.
 * The returned object is a copy of the server environment overlaid with the
 * values emitted by mise for the target cwd.
 */
async function loadProjectEnvironmentSnapshot(
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectEnvironmentSnapshot> {
  const resolvedCwd = resolve(cwd);
  const inherited = { ...baseEnvironment };
  const configDir = findNearestMiseConfigDir(resolvedCwd);
  if (!configDir) return { environment: inherited, managedEnvironment: {} };

  try {
    // Keep the same trust behavior as pi-mise. Trust is idempotent and also
    // re-applies trust after mise invalidates a changed configuration file.
    await runMise(["trust"], configDir, inherited);
    const { stdout } = await runMise(["env", "-C", resolvedCwd, "--json"], resolvedCwd, inherited);
    const managedEnvironment = parseMiseEnvironment(stdout);
    return {
      environment: { ...inherited, ...managedEnvironment },
      managedEnvironment,
    };
  } catch (error) {
    if (isMissingExecutable(error)) {
      console.warn(`[pi-web] mise is not installed; using the inherited environment for ${resolvedCwd}`);
      return { environment: inherited, managedEnvironment: {} };
    }
    throw new Error(`Failed to load mise environment for ${resolvedCwd}`);
  }
}

export async function loadProjectEnvironment(
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  return (await loadProjectEnvironmentSnapshot(cwd, baseEnvironment)).environment;
}

export async function createProjectEnvironment(
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectEnvironmentContext> {
  const resolvedCwd = resolve(cwd);
  const inherited = { ...baseEnvironment };
  let snapshot = await loadProjectEnvironmentSnapshot(resolvedCwd, inherited);

  return {
    cwd: resolvedCwd,
    getEnvironment: () => snapshot.environment,
    getManagedEnvironment: () => snapshot.managedEnvironment,
    reload: async () => {
      snapshot = await loadProjectEnvironmentSnapshot(resolvedCwd, inherited);
    },
  };
}

export function toProviderEnvironment(environment: Record<string, string | undefined>): ProviderEnv {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Bind a session's environment to the SDK's auth and request paths.
 *
 * The current coding-agent SDK reads auth context from process.env and does
 * not expose a session-level environment option. Its ModelRuntime internals
 * are deliberately kept behind this small compatibility adapter until that
 * option is public. The runtime itself remains isolated per AgentSession.
 */
export function bindProjectEnvironmentToModelRuntime(
  runtime: ModelRuntime,
  projectEnvironment: ProjectEnvironmentContext,
): Promise<void> {
  const internals = runtime as unknown as RuntimeInternals;
  const models = internals.models;
  if (!models || !internals.prepareRequest) {
    throw new Error("The installed Pi SDK does not support project-scoped environments");
  }

  const hostAuthContext = defaultProviderAuthContext();
  models.authContext = {
    async env(name) {
      const environment = projectEnvironment.getEnvironment();
      if (Object.prototype.hasOwnProperty.call(environment, name)) return environment[name];
      return hostAuthContext.env(name);
    },
    fileExists: (path) => hostAuthContext.fileExists(path),
  };

  const originalPrepareRequest = internals.prepareRequest.bind(runtime);
  internals.prepareRequest = (model, options) => {
    const projectEnv = toProviderEnvironment(projectEnvironment.getEnvironment());
    return originalPrepareRequest(model, {
      ...(options ?? {}),
      env: { ...projectEnv, ...(options?.env ?? {}) },
    });
  };

  const managedApiKeyProviders = new Set<string>();
  const applyManagedApiKeys = async () => {
    for (const providerId of managedApiKeyProviders) {
      await runtime.removeRuntimeApiKey(providerId);
    }
    managedApiKeyProviders.clear();

    const managedEnvironment = toProviderEnvironment(projectEnvironment.getManagedEnvironment());
    for (const provider of runtime.getProviders()) {
      const envName = findEnvKeys(provider.id, managedEnvironment)?.find((name) =>
        Object.prototype.hasOwnProperty.call(managedEnvironment, name)
        && !NON_API_KEY_ENV_NAMES.has(name),
      );
      if (!envName) continue;
      const apiKey = managedEnvironment[envName];
      if (!apiKey) continue;
      managedApiKeyProviders.add(provider.id);
      await runtime.setRuntimeApiKey(provider.id, apiKey);
    }
  };
  let refreshTail = Promise.resolve();
  const refresh = () => {
    const next = refreshTail.then(applyManagedApiKeys);
    refreshTail = next.catch(() => {});
    return next;
  };
  runtimeBindings.set(runtime, { refresh });
  return refresh();
}

export async function refreshProjectModelRuntime(runtime: ModelRuntime): Promise<void> {
  await runtimeBindings.get(runtime)?.refresh();
}

/**
 * Exclude the third-party pi-mise extension from Pi Web sessions.
 *
 * Pi Web loads mise project environments itself (see above) without any
 * per-session logging. The pi-mise package instead prints
 * `[pi-mise] mise activated (...)` via console.log plus a UI notification on
 * every session_start, which spams the Pi Web server log on each session
 * start/reload. Filtering it here keeps the user's CLI setup untouched —
 * the extension still loads in the `pi` TUI — while Pi Web sessions stay quiet.
 */
export function withoutPiMiseExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const isPiMise = (path: string, source?: string) =>
    path.replaceAll("\\", "/").toLowerCase().includes("pi-mise")
    || (source ?? "").toLowerCase().includes("pi-mise");
  const removedPaths = new Set(
    base.extensions
      .filter((extension) => isPiMise(extension.path, extension.sourceInfo?.source))
      .map((extension) => extension.path),
  );
  if (removedPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !removedPaths.has(extension.path)),
    errors: base.errors.filter((error) => !isPiMise(error.path, undefined)),
  };
}

export async function createProjectModelRuntime(
  projectEnvironment: ProjectEnvironmentContext,
): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  await bindProjectEnvironmentToModelRuntime(runtime, projectEnvironment);
  return runtime;
}

