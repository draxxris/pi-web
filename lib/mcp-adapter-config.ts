import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isExistingFilePathAllowed } from "./file-access";
import { stripJsonComments } from "./jsonc";
import { serializeByKey } from "./key-serializer";

const WRITE_QUEUE: symbol = Symbol.for("pi-web:mcp-adapter-write-queue");
import type {
  McpAdapterAction,
  McpAdapterFileInfo,
  McpAdapterInstall,
  McpAdapterOverview,
  McpAdapterRefusalReason,
  McpAdapterScope,
  McpAdapterServer,
  McpAdapterState,
} from "./mcp-adapter-types";
import { readAdapterLiveStatus } from "./mcp-adapter-status";
import { maskArgs, maskCommand, maskUrl } from "./mcp-secrets";
import { readRegularFileText } from "./regular-file";

// Settings › MCP › Adapter reads and writes pi-mcp-adapter's own files
// (docs/agents/mcp-adapter.md). Reading never runs or connects anything and
// never loads the adapter's code (it needs modules pi provides at run time).
// The sources and their order follow the adapter's docs/configuration.md; the
// merge is the adapter's per-server field merge, without its imports, plugins
// and host-config discovery. Pi's own `mcp.json` files are the Built-in tab's.

const MAX_BYTES = 1024 * 1024;
const ADAPTER_PACKAGE = "pi-mcp-adapter";

/** Thrown for a refusal the route turns into a typed answer. */
export class McpAdapterError extends Error {
  constructor(
    readonly reason: McpAdapterRefusalReason,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

interface SourceSpec {
  id: string;
  scope: McpAdapterScope;
  path: string;
  override: boolean;
  /** A project file is read only when it resolves inside these roots. */
  roots?: Set<string>;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function adapterOverridePath(agentDir: string, scope: McpAdapterScope, cwd: string | undefined): string | undefined {
  if (scope === "global") return join(agentDir, "mcp-adapter.json");
  return cwd ? join(cwd, ".pi", "mcp-adapter.json") : undefined;
}

/** The adapter's sources, lowest precedence first. */
export function adapterSources(agentDir: string, project: { cwd: string; allowedRoots: Set<string> } | undefined): SourceSpec[] {
  const home = homedir();
  const sources: SourceSpec[] = [
    { id: "shared-global", scope: "global", path: join(home, ".config", "mcp", "mcp.json"), override: false },
    { id: "agents-global", scope: "global", path: join(home, ".agents", "mcp.json"), override: false },
    { id: "agents-nested-global", scope: "global", path: join(home, ".agents", "mcp", "mcp.json"), override: false },
    { id: "adapter-global", scope: "global", path: join(agentDir, "mcp-adapter.json"), override: true },
  ];
  if (project) {
    const roots = project.allowedRoots;
    sources.push(
      { id: "shared-project", scope: "project", path: join(project.cwd, ".mcp.json"), override: false, roots },
      { id: "adapter-project", scope: "project", path: join(project.cwd, ".pi", "mcp-adapter.json"), override: true, roots },
    );
  }
  return sources;
}

interface ReadSource {
  spec: SourceSpec;
  exists: boolean;
  problem?: string;
  servers: Map<string, { [key: string]: unknown }>;
  /** Servers whose entry is not an object: listed nowhere, Remove still works. */
}

function readSource(spec: SourceSpec): ReadSource {
  const result: ReadSource = { spec, exists: false, servers: new Map() };
  let path = spec.path;
  try {
    if (spec.roots) {
      // A repository-controlled file: its real path must stay inside the allowed roots.
      try {
        path = realpathSync(spec.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
          return existsSyncSafe(spec.path) ? { ...result, problem: "link-dangling" } : result;
        }
        throw error;
      }
      if (!isExistingFilePathAllowed(path, spec.roots)) return { ...result, exists: true, problem: "link-outside" };
    }
    const text = readRegularFileText(path, MAX_BYTES);
    if (text === undefined) return result;
    result.exists = true;
    if (stripJsonComments(text.replace(/^\uFEFF/, "")).trim() === "") return result;
    const parsed: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
    if (!isRecord(parsed)) return { ...result, problem: "invalid-shape" };
    const servers = serversObject(parsed);
    if (servers === "invalid") return { ...result, problem: "invalid-shape" };
    for (const [name, entry] of Object.entries(servers ?? {})) {
      if (isRecord(entry)) result.servers.set(name, entry);
    }
    return result;
  } catch (error) {
    // Never quote the file: V8's syntax errors often include a literal secret.
    const code = (error as NodeJS.ErrnoException).code;
    return { ...result, exists: result.exists || code !== "ENOENT", problem: error instanceof SyntaxError ? "unparsable" : "unreadable" };
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function serversObject(raw: { [key: string]: unknown }): { [key: string]: unknown } | undefined | "invalid" {
  const value = raw.mcpServers !== undefined ? raw.mcpServers : raw["mcp-servers"];
  if (value === undefined) return undefined;
  return isRecord(value) ? value : "invalid";
}

// A higher source that repoints a server at another URL must not inherit
// credentials bound to the old one (the adapter's mergeServerMaps).
const URL_BOUND = ["headers", "bearerToken", "bearerTokenEnv", "bearerTokenStore", "requestHeadersCommand", "caFile", "auth", "oauth"];

function mergeEntry(base: { [key: string]: unknown } | undefined, next: { [key: string]: unknown }): { [key: string]: unknown } {
  if (!base) return { ...next };
  const merged: { [key: string]: unknown } = { ...base, ...next };
  if (typeof next.url === "string" && next.url !== base.url) {
    for (const field of URL_BOUND) if (!Object.hasOwn(next, field)) delete merged[field];
  }
  return merged;
}

interface Merged {
  entry: { [key: string]: unknown };
  scope: McpAdapterScope;
  file: string;
  definedIn: string[];
}

function mergeSources(sources: ReadSource[], exclude?: string): Map<string, Merged> {
  const merged = new Map<string, Merged>();
  for (const source of sources) {
    if (source.spec.path === exclude) continue;
    for (const [name, entry] of source.servers) {
      const existing = merged.get(name);
      merged.set(name, {
        entry: mergeEntry(existing?.entry, entry),
        scope: source.spec.scope,
        file: source.spec.path,
        definedIn: [...(existing?.definedIn ?? []), source.spec.path],
      });
    }
  }
  return merged;
}

// ── install ────────────────────────────────────────────────────────────────

function readJsonFile(path: string): unknown {
  try {
    const text = readRegularFileText(path, MAX_BYTES);
    return text === undefined ? undefined : JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
  } catch {
    return undefined;
  }
}

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : isRecord(item) && typeof item.source === "string" ? [item.source] : []));
}

export function readAdapterInstall(agentDir: string): McpAdapterInstall {
  const settings = readJsonFile(join(agentDir, "settings.json"));
  const entries = isRecord(settings) ? [...stringEntries(settings.packages), ...stringEntries(settings.extensions)] : [];
  const installed = entries.some((entry) => !/^[-!]/.test(entry) && entry.includes(ADAPTER_PACKAGE));
  const builtinOff = entries.some((entry) => entry === "-builtin:mcp");
  const manifest = readJsonFile(join(agentDir, "npm", "node_modules", ADAPTER_PACKAGE, "package.json"));
  const version = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  return { installed, builtinOff, ...(version ? { version } : {}) };
}

// ── metadata cache ─────────────────────────────────────────────────────────

function readCachedTools(agentDir: string): Map<string, string[]> {
  const cache = readJsonFile(join(agentDir, "mcp-cache.json"));
  const out = new Map<string, string[]>();
  if (!isRecord(cache) || !isRecord(cache.servers)) return out;
  for (const [name, value] of Object.entries(cache.servers)) {
    if (!isRecord(value) || !Array.isArray(value.tools)) continue;
    out.set(name, value.tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])));
  }
  return out;
}

// ── listing ────────────────────────────────────────────────────────────────

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function directToolsOf(value: unknown): McpAdapterServer["directTools"] {
  if (value === true) return true;
  if (value === "search") return "search";
  if (Array.isArray(value)) return stringArray(value);
  return undefined;
}

function toServer(
  name: string,
  merged: Merged,
  cached: string[] | undefined,
  live: ReturnType<typeof readAdapterLiveStatus>,
): McpAdapterServer {
  const { entry } = merged;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  const command = typeof entry.command === "string" ? entry.command : undefined;
  let target: string | undefined;
  let masked = false;
  if (url) {
    const m = maskUrl(url);
    target = m.value;
    masked = m.masked;
  } else if (command) {
    const c = maskCommand(command);
    const a = maskArgs(stringArray(entry.args));
    target = [c.value, ...a.args].join(" ");
    masked = c.masked || a.masked;
  }
  const disabled = entry.disabled === true;
  const report = live?.servers.get(name);
  let state: McpAdapterState = disabled ? "disabled" : cached ? "cached" : "unknown";
  if (report) {
    state = (["connected", "needs-auth", "failed", "cached", "not-connected", "blocked", "disabled"] as const).find((s) => s === report.status) ?? state;
  }
  const oauth = entry.oauth !== undefined && entry.oauth !== false || entry.auth === "oauth";
  const directTools = directToolsOf(entry.directTools);
  return {
    name,
    scope: merged.scope,
    file: merged.file,
    definedIn: merged.definedIn,
    transport: url ? "http" : "stdio",
    ...(target !== undefined ? { target } : {}),
    masked,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(directTools !== undefined ? { directTools } : {}),
    ...(typeof entry.lifecycle === "string" ? { lifecycle: entry.lifecycle } : {}),
    // Names only: values may be secrets.
    envNames: isRecord(entry.env) ? Object.keys(entry.env) : [],
    headerNames: isRecord(entry.headers) ? Object.keys(entry.headers) : [],
    oauth,
    disabled,
    state,
    live: report !== undefined,
    ...(report ? { toolCount: report.toolCount, directToolCount: report.directToolCount } : {}),
    ...(report?.resourceCount !== undefined ? { resourceCount: report.resourceCount } : {}),
    ...(report?.failedAgoSeconds !== undefined ? { failedAgoSeconds: report.failedAgoSeconds } : {}),
    ...(report?.blockedReason ? { blockedReason: report.blockedReason } : {}),
    cachedTools: cached ?? [],
  };
}

export interface McpAdapterProject {
  cwd: string;
  allowedRoots: Set<string>;
}

export function readAdapterOverview(options: { agentDir: string; project?: McpAdapterProject }): McpAdapterOverview {
  const { agentDir, project } = options;
  const read = adapterSources(agentDir, project).map(readSource);
  const merged = mergeSources(read);
  const cached = readCachedTools(agentDir);
  const live = readAdapterLiveStatus(project?.cwd);
  const servers = [...merged].map(([name, m]) => toServer(name, m, cached.get(name), live));
  const files: McpAdapterFileInfo[] = read.map((source) => ({
    id: source.spec.id,
    scope: source.spec.scope,
    path: source.spec.path,
    exists: source.exists,
    ...(source.problem ? { problem: source.problem } : {}),
    serverCount: source.servers.size,
    override: source.spec.override,
  }));
  return {
    install: readAdapterInstall(agentDir),
    files,
    servers,
    ...(live ? { liveAgeMs: Date.now() - live.updatedAt } : {}),
    ...(project ? { projectCwd: project.cwd } : {}),
  };
}

// ── writes ─────────────────────────────────────────────────────────────────

interface RawFile {
  path: string;
  realPath: string;
  raw: { [key: string]: unknown };
  servers: { [key: string]: unknown };
  /** Where `servers` hangs in `raw`. */
  key: "mcpServers" | "mcp-servers";
  mode: number;
}

function readRawForWrite(path: string, roots: Set<string> | undefined, create: boolean): RawFile {
  let realPath = path;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw new McpAdapterError("server-missing", "The file no longer exists");
    // A file that does not exist yet: the adapter creates it, so its folder is what must stay in the roots.
    if (isSymbolicLink(path)) throw new McpAdapterError("link-outside", "A symbolic link to nothing");
    if (roots) {
      // Folders on the way may not exist yet (`.pi/`): the nearest one that
      // does must stay in the roots, and none of the rest can be a link.
      let parent = dirname(path);
      while (!existsSyncSafe(parent) && dirname(parent) !== parent) parent = dirname(parent);
      if (!isExistingFilePathAllowed(parent, roots)) {
        throw new McpAdapterError("link-outside", "The file resolves outside the folders Pi Web may access");
      }
    }
    realPath = join(realpathOrSelf(dirname(path)), basename(path));
  }
  // An existing file, links included, must stay in the roots; the create case checked its folder above.
  if (roots && existsSyncSafe(realPath) && !isExistingFilePathAllowed(realPath, roots)) {
    throw new McpAdapterError("link-outside", "The file resolves outside the folders Pi Web may access");
  }
  const text = existsSyncSafe(realPath) ? readRegularFileText(realPath, MAX_BYTES) : undefined;
  let raw: { [key: string]: unknown } = {};
  // The global override may hold literal secrets; a project file keeps a shared file's mode.
  let mode = roots ? 0o644 : 0o600;
  if (text !== undefined) {
    const body = text.replace(/^\uFEFF/, "");
    const stripped = stripJsonComments(body);
    // Rewriting would drop the comments: refuse instead of losing the user's notes.
    if (stripped !== body) {
      throw new McpAdapterError("has-comments", "The file has comments, which a change here would remove: edit it by hand");
    }
    try {
      const parsed: unknown = stripped.trim() === "" ? {} : JSON.parse(stripped);
      if (!isRecord(parsed)) throw new McpAdapterError("invalid-shape", "The file is not a JSON object");
      raw = parsed;
    } catch (error) {
      if (error instanceof McpAdapterError) throw error;
      throw new McpAdapterError("unparsable", "The file is not valid JSON");
    }
    mode = statSync(realPath).mode & 0o777;
  }
  const key = raw.mcpServers === undefined && raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
  const servers = serversObject(raw);
  if (servers === "invalid") throw new McpAdapterError("invalid-shape", "The file's server list is not an object");
  return { path, realPath, raw, servers: servers ?? {}, key, mode };
}

function writeRaw(file: RawFile): void {
  file.raw[file.key] = file.servers;
  mkdirSync(dirname(file.realPath), { recursive: true });
  const temp = `${file.realPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file.raw, null, 2)}\n`, { flag: "wx", mode: file.mode });
  chmodSync(temp, file.mode);
  renameSync(temp, file.realPath);
}

function setOwn(target: { [key: string]: unknown }, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
}

export interface McpAdapterChange {
  agentDir: string;
  project?: McpAdapterProject;
  action: McpAdapterAction;
  name: string;
}

export async function changeAdapterServer(change: McpAdapterChange): Promise<void> {
  const { agentDir, project, action, name } = change;
  if (name === "__proto__" || name === "") throw new McpAdapterError("invalid-request", "Invalid server name", 400);
  const sources = adapterSources(agentDir, project).map(readSource);
  const merged = mergeSources(sources);
  const current = merged.get(name);
  if (!current) throw new McpAdapterError("server-missing", "The adapter's files no longer define this server");
  const roots = project?.allowedRoots;
  const key = (path: string) => `mcp-adapter-write:${path}`;

  if (action === "remove") {
    const spec = sources.find((source) => source.spec.path === current.file)!.spec;
    await serializeByKey(WRITE_QUEUE, key(spec.path), async () => {
      const file = readRawForWrite(spec.path, spec.roots ?? roots, false);
      if (!Object.hasOwn(file.servers, name)) throw new McpAdapterError("server-missing", "The file no longer defines this server");
      delete file.servers[name];
      writeRaw(file);
    });
    return;
  }

  // Enable / disable go to the adapter-owned override file of the server's scope, never a shared file.
  const overridePath = adapterOverridePath(agentDir, current.scope, project?.cwd);
  if (!overridePath) throw new McpAdapterError("invalid-request", "A project server needs the project's cwd", 400);
  const overrideRoots = current.scope === "project" ? roots : undefined;
  const disabledBelow = mergeSources(sources, overridePath).get(name)?.entry.disabled === true;
  await serializeByKey(WRITE_QUEUE, key(overridePath), async () => {
    const file = readRawForWrite(overridePath, overrideRoots, true);
    const existing = Object.hasOwn(file.servers, name) ? file.servers[name] : undefined;
    if (existing !== undefined && !isRecord(existing)) throw new McpAdapterError("invalid-shape", "The override entry is not an object");
    const next: { [key: string]: unknown } = { ...existing };
    if (action === "disable") next.disabled = true;
    else if (disabledBelow) next.disabled = false;
    else delete next.disabled;
    if (existing === undefined && Object.keys(next).length === 0) return;
    if (JSON.stringify(existing) === JSON.stringify(next)) return;
    if (Object.keys(next).length === 0) delete file.servers[name];
    else setOwn(file.servers, name, next);
    writeRaw(file);
  });
}
