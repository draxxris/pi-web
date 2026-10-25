// Client-safe shapes of Settings › MCP › Adapter: pi-mcp-adapter's servers,
// read from its files and its live status events (docs/agents/mcp-adapter.md).

export type McpAdapterScope = "global" | "project";

/** The adapter's runtime states (its status snapshot), plus `unknown` for a server no session has reported. */
export type McpAdapterState =
  | "connected"
  | "needs-auth"
  | "failed"
  | "cached"
  | "not-connected"
  | "blocked"
  | "disabled"
  | "unknown";

export interface McpAdapterFileInfo {
  id: string;
  scope: McpAdapterScope;
  path: string;
  exists: boolean;
  /** Why the file is not read (`unparsable`, `link-outside`, …); never quotes the file. */
  problem?: string;
  serverCount: number;
  /** The adapter-owned file that holds overrides (enable/disable). */
  override: boolean;
}

export interface McpAdapterServer {
  name: string;
  scope: McpAdapterScope;
  /** The last file that defines the server: the one a Remove changes. */
  file: string;
  /** Every file that defines it, lowest precedence first. */
  definedIn: string[];
  transport: "stdio" | "http";
  /** Masked command line or URL. */
  target?: string;
  masked: boolean;
  description?: string;
  /** `directTools`: true, a list of tool names, or "search". */
  directTools?: true | string[] | "search";
  lifecycle?: string;
  envNames: string[];
  headerNames: string[];
  oauth: boolean;
  disabled: boolean;
  state: McpAdapterState;
  /** The state came from a running session, not only from files. */
  live: boolean;
  toolCount?: number;
  directToolCount?: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  blockedReason?: string;
  /** Tool names from the adapter's metadata cache. */
  cachedTools: string[];
}

export interface McpAdapterInstall {
  /** `pi-mcp-adapter` is among the settings' packages. */
  installed: boolean;
  version?: string;
  /** `-builtin:mcp` is set, so the adapter owns `/mcp`. */
  builtinOff: boolean;
}

export interface McpAdapterOverview {
  install: McpAdapterInstall;
  files: McpAdapterFileInfo[];
  servers: McpAdapterServer[];
  /** A session reported its status after this many ms ago; undefined when none did. */
  liveAgeMs?: number;
  projectCwd?: string;
}

export type McpAdapterAction = "enable" | "disable" | "remove";

export type McpAdapterRefusalReason =
  | "request-denied"
  | "content-type"
  | "invalid-request"
  | "cwd-invalid"
  | "cwd-denied"
  | "cwd-not-directory"
  | "project-untrusted"
  | "trust-unreadable"
  | "server-missing"
  | "has-comments"
  | "unparsable"
  | "invalid-shape"
  | "link-outside"
  | "locked"
  | "internal";

export interface McpAdapterErrorResponse {
  error: string;
  reason: McpAdapterRefusalReason;
}
