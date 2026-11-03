import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { projectEnvTrust, readProjectEnvFor } from "./project-env";

/**
 * A project `.env`'s provider credentials, applied to the `ModelRuntime` of the
 * session that project is starting.
 *
 * Every session builds its own runtime (`createAgentSessionServices()` without
 * a `modelRuntime` option), and `ModelRuntime.setRuntimeApiKey()` writes only
 * that runtime's in-memory credential override, so two projects open at once
 * each authenticate with their own key: nothing touches `process.env`, nothing
 * is written to `auth.json`, and the key dies with the session.
 *
 * Which variables count is asked of pi, never assumed here. `getAuth()` with the
 * file's names as the environment answers "which of these would pi authenticate
 * this provider from, as an API key", so no table of variable names is copied
 * out of the SDK and kept in step with it. The answer also gets the awkward
 * cases right: pi's own precedence between a provider's variables decides which
 * name wins (not the order of the file's lines), `ANTHROPIC_AUTH_TOKEN` resolves
 * to an `Authorization: Bearer` header rather than an API key and so is left
 * alone, and a provider that authenticates itself from ambient credentials
 * (`amazon-bedrock`, `google-vertex`) matches nothing.
 */

/**
 * Marks a probe value, and carries which name pi chose: the answer identifies
 * the variable by the marker, never by the value. The terminator makes the
 * marker exact — a `models.json` `apiKey` of `${NAME}0` would otherwise resolve
 * to another variable's marker plus a digit and be read as that index.
 */
const PROBE_PREFIX = "\u0000pi-web-project-env:";
const PROBE_END = "\u0000";
const PROBE_PATTERN = /^\u0000pi-web-project-env:(\d+)\u0000$/;

function probeValue(index: number): string {
  return `${PROBE_PREFIX}${index}${PROBE_END}`;
}

export interface ProjectEnvKeyApplied {
  provider: string;
  /** The `.env` name that supplied it, never the value. */
  name: string;
}

/**
 * What pi answered for one provider: the index of the name it would authenticate
 * from, `"contaminated"` when it used the file's values for more than the API key
 * (a bearer header, a provider env value such as Cloudflare's account id), which
 * a runtime API key cannot carry, and `"none"` when it used none of them.
 */
type ProbeOutcome = { index: number } | "contaminated" | "none";

/** The parts of an auth answer these checks read (a header may be null: "deleted"). */
interface ProbeResultLike {
  env?: Record<string, string | undefined>;
  auth: { apiKey?: string; headers?: Record<string, string | null | undefined> };
}

/** Whether the overlay's values reached somewhere other than the key itself. */
function usedBeyondKey(result: ProbeResultLike, ownKey?: string): boolean {
  const inEnv = Object.values(result.env ?? {})
    .some((value) => typeof value === "string" && value.includes(PROBE_PREFIX) && value !== ownKey);
  // `authHeader: true` legitimately derives an `Authorization` header from the
  // key, so a header that ends in the key we were given is not a second use.
  const inHeaders = Object.values(result.auth.headers ?? {})
    .some((value) => typeof value === "string" && value.includes(PROBE_PREFIX) && !(ownKey && value.endsWith(ownKey)));
  return inEnv || inHeaders;
}

async function askProvider(
  runtime: ModelRuntime,
  providerId: string,
  env: Record<string, string>,
): Promise<ProbeOutcome> {
  let result;
  try {
    result = await runtime.getAuth(providerId, { env });
  } catch {
    // A provider whose auth resolution fails is one this file cannot configure.
    return "none";
  }
  if (!result) return "none";
  const key = result.auth.apiKey;
  const match = typeof key === "string" ? PROBE_PATTERN.exec(key) : null;
  if (!match) return usedBeyondKey(result) ? "contaminated" : "none";
  return usedBeyondKey(result, key) ? "contaminated" : { index: Number(match[1]) };
}

/**
 * Which of the file's names pi would authenticate `providerId` from, if any. One
 * probe with every name first — one call per provider rather than one per
 * variable, which also keeps a `models.json` header `!command` from running once
 * per variable. A provider that consumed the values somewhere else is asked
 * again one name at a time, and only an answer that needs nothing but the key is
 * taken; otherwise the provider keeps the credentials it has.
 */
async function keyIndexFor(
  runtime: ModelRuntime,
  providerId: string,
  names: readonly string[],
): Promise<number | undefined> {
  const combined: Record<string, string> = {};
  names.forEach((name, index) => {
    combined[name] = probeValue(index);
  });
  const outcome = await askProvider(runtime, providerId, combined);
  if (typeof outcome === "object") return outcome.index;
  if (outcome === "none") return undefined;
  for (const [index, name] of names.entries()) {
    const single = await askProvider(runtime, providerId, { [name]: probeValue(index) });
    if (typeof single === "object") return single.index;
  }
  return undefined;
}

/**
 * Sets each provider's key that `values` supplies and returns what it set, in
 * provider order. A provider with a stored credential (`auth.json`, an OAuth
 * sign-in) or an explicit `models.json` key keeps it: pi's own rule is that a
 * stored credential owns the provider, and a project file must not quietly take
 * over an account signed in to from Settings. A `models.json` `apiKey` written
 * as `${NAME}` reads the project's value for that name, as it would from the
 * daemon's environment, but only while nothing else the provider needs is left
 * unresolved.
 */
export async function applyProjectEnvKeys(
  runtime: ModelRuntime,
  values: Record<string, string>,
): Promise<ProjectEnvKeyApplied[]> {
  const candidates = Object.entries(values)
    .map(([name, value]) => [name, value.trim()] as const)
    .filter(([, value]) => value.length > 0);
  if (candidates.length === 0) return [];
  const names = candidates.map(([name]) => name);

  const stored = new Set((await runtime.listCredentials()).map((entry) => entry.providerId));
  const applied: ProjectEnvKeyApplied[] = [];
  for (const provider of runtime.getProviders()) {
    if (stored.has(provider.id)) continue;
    const status = runtime.getProviderAuthStatus(provider.id);
    if (status.source === "models_json_key" || status.source === "models_json_command") continue;
    const index = await keyIndexFor(runtime, provider.id, names);
    const candidate = index === undefined ? undefined : candidates[index];
    if (!candidate) continue;
    const [name, value] = candidate;
    try {
      await runtime.setRuntimeApiKey(provider.id, value);
    } catch {
      // This provider keeps the credentials it had; the others still get theirs.
      continue;
    }
    applied.push({ provider: provider.id, name });
  }
  return applied;
}

/**
 * The whole step at a session's start or a model listing: read the project's
 * `.env` and apply its provider keys to `runtime`. Never throws — an unreadable
 * file, an undecidable trust decision or a provider that refuses the credential
 * leaves the runtime on the credentials it already has, so a project's key file
 * cannot stop a session from starting.
 */
export async function applyProjectEnvFor(
  runtime: ModelRuntime,
  cwd: string,
  agentDir: string,
): Promise<ProjectEnvKeyApplied[]> {
  try {
    const projectEnv = readProjectEnvFor(cwd, projectEnvTrust(agentDir));
    if (Object.keys(projectEnv.values).length === 0) return [];
    return await applyProjectEnvKeys(runtime, projectEnv.values);
  } catch {
    return [];
  }
}
