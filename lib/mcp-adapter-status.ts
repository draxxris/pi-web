import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

// pi-mcp-adapter publishes a read-only status snapshot on the session's event
// bus (`pi-mcp-adapter/status/v1`) after init and on every change, and an
// empty one at shutdown. Each Pi Web session gets a bus of its own that keeps
// the latest snapshot here, so Settings › MCP › Adapter shows what a running
// session sees without connecting anything. The map lives on globalThis (hot
// reload re-evaluates modules); a server restart forgets it.

export const MCP_ADAPTER_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export interface AdapterStatusServer {
  name: string;
  status: string;
  toolCount: number;
  directToolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
  blockedReason?: string;
}

interface SessionRecord {
  cwd: string;
  servers: AdapterStatusServer[];
  updatedAt: number;
}

const STORE_KEY: symbol = Symbol.for("pi-web:mcp-adapter-status");

function store(): Map<number, SessionRecord> {
  const g = globalThis as { [key: symbol]: Map<number, SessionRecord> | undefined };
  return (g[STORE_KEY] ??= new Map());
}

let nextId = 1;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseAdapterSnapshot(data: unknown): AdapterStatusServer[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return undefined;
  const out: AdapterStatusServer[] = [];
  for (const item of servers) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as { [key: string]: unknown };
    const name = str(s.name);
    const status = str(s.status);
    if (name === undefined || status === undefined) continue;
    const resourceCount = num(s.resourceCount);
    const failedAgoSeconds = num(s.failedAgoSeconds);
    const blockedReason = str(s.blockedReason);
    out.push({
      name,
      status,
      toolCount: num(s.toolCount) ?? 0,
      directToolCount: num(s.directToolCount) ?? 0,
      ...(resourceCount !== undefined ? { resourceCount } : {}),
      ...(failedAgoSeconds !== undefined ? { failedAgoSeconds } : {}),
      disabled: s.disabled === true,
      ...(blockedReason ? { blockedReason } : {}),
    });
  }
  return out;
}

/** An event bus for one session's resource loader that records the adapter's snapshots for `cwd`. */
export function createAdapterStatusBus(cwd: string): EventBus {
  const bus = createEventBus();
  const id = nextId++;
  bus.on(MCP_ADAPTER_STATUS_EVENT, (data) => {
    const servers = parseAdapterSnapshot(data);
    if (!servers) return;
    // The empty snapshot is the session's shutdown.
    if (servers.length === 0) store().delete(id);
    else store().set(id, { cwd, servers, updatedAt: Date.now() });
  });
  return bus;
}

export interface AdapterLiveStatus {
  servers: Map<string, AdapterStatusServer>;
  updatedAt: number;
}

/**
 * The newest snapshot of a session in `cwd`, else of any session (global
 * servers are the same everywhere). Undefined while no session reported.
 */
export function readAdapterLiveStatus(cwd: string | undefined): AdapterLiveStatus | undefined {
  let best: SessionRecord | undefined;
  let bestSameCwd = false;
  for (const record of store().values()) {
    const same = cwd !== undefined && record.cwd === cwd;
    if (!best || (same && !bestSameCwd) || (same === bestSameCwd && record.updatedAt > best.updatedAt)) {
      best = record;
      bestSameCwd = same;
    }
  }
  if (!best) return undefined;
  return { servers: new Map(best.servers.map((server) => [server.name, server])), updatedAt: best.updatedAt };
}

export function resetAdapterLiveStatusForTests(): void {
  store().clear();
}
