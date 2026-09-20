import { sessionPathKey } from "./session-path";
import type { AgentSessionLike } from "./pi-types";

const INTERACTION_SESSION_REGISTRY = Symbol.for("pi.subagents.interactionSessions");

type RegisteredSubagentSession = {
  origin?: unknown;
  sessionFile?: unknown;
  session?: unknown;
  stop?: (reason: string) => Promise<void> | void;
};

function getRegistry(): Map<unknown, RegisteredSubagentSession> | null {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: Map<unknown, RegisteredSubagentSession> | undefined;
  };
  const registry = globalRecord[INTERACTION_SESSION_REGISTRY];
  return registry instanceof Map ? registry : null;
}

/**
 * Session ids of sub-agent runs currently live in this process, taken from the
 * shared pi-subagents-j0k3r interaction registry. Entries exist exactly for the
 * lifetime of a nested run (registered before the prompt, unregistered in its
 * finally block), so presence here means "waiting on model or running tools".
 */
export function getLiveSubagentSessionIds(): string[] {
  const registry = getRegistry();
  if (!registry) return [];
  const ids: string[] = [];
  for (const [sessionId, entry] of registry) {
    if (entry.origin !== "subagent") continue;
    if (typeof sessionId === "string" && sessionId.length > 0) ids.push(sessionId);
  }
  return ids;
}

function isAgentSessionLike(value: unknown): value is AgentSessionLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { sessionId?: unknown; prompt?: unknown; steer?: unknown };
  return typeof candidate.sessionId === "string"
    && typeof candidate.prompt === "function"
    && typeof candidate.steer === "function";
}

/**
 * The live AgentSession behind a running j0k3r nested run, when the host
 * published the handle in the interaction registry. Pi Web wraps this object
 * directly so steer/follow-up/prompt reach the running subagent instead of a
 * stale shadow session. Returns null when the handle is absent or malformed.
 */
export function getLiveSubagentSession(sessionId: string): AgentSessionLike | null {
  const registry = getRegistry();
  const entry = registry?.get(sessionId);
  if (!entry || entry.origin !== "subagent") return null;
  return isAgentSessionLike(entry.session) ? entry.session : null;
}

/**
 * Live j0k3r runs whose session handle is unavailable, so Pi Web cannot attach
 * a wrapper. These stay read-only: the client watches the JSONL file and
 * refuses turn-injection commands instead of opening a second AgentSession.
 */
export function getUnmanagedSubagentSessionIds(): string[] {
  const registry = getRegistry();
  if (!registry) return [];
  const ids: string[] = [];
  for (const [sessionId, entry] of registry) {
    if (entry.origin !== "subagent") continue;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    if (isAgentSessionLike(entry.session)) continue;
    ids.push(sessionId);
  }
  return ids;
}

/** Stop active j0k3r sessions before Pi Web removes their JSONL files. */
export async function stopRegisteredSubagentSessions(
  sessionPaths: readonly string[],
  reason: string,
): Promise<void> {
  const registry = getRegistry();
  if (!registry || sessionPaths.length === 0) return;

  const wanted = new Set(sessionPaths.map((filePath) => sessionPathKey(filePath)));
  const stops = new Map<string, (reason: string) => Promise<void> | void>();
  for (const entry of registry.values()) {
    if (entry.origin !== "subagent" || typeof entry.sessionFile !== "string" || typeof entry.stop !== "function") continue;
    const key = sessionPathKey(entry.sessionFile);
    if (wanted.has(key)) stops.set(key, entry.stop);
  }

  const results = await Promise.allSettled([...stops.values()].map((stop) => stop(reason)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    throw failure.reason instanceof Error
      ? failure.reason
      : new Error(String(failure.reason));
  }
}
