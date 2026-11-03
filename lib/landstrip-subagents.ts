// pi-landstrip's subagent tasks are not part of the session catalogue: another
// pi process (the CLI running the pi-landstrip extension) owns them, writes each
// run's session file one level deeper than the catalogue scans
// (~/.pi/agent/sessions/pi-landstrip/<parentSessionId>/<taskId>/*.jsonl), and
// appends the run's own record as a `landstrip.task` custom entry to the parent
// session. Both are read here, so the Agents switcher can list those runs beside
// pi-web's own subagents; nothing here starts, prompts or deletes one.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadStream, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type { SubagentSessionStatus } from "./types";
import { scanSessionFileInfo, type ScannedSessionInfo } from "./session-list-scanner";

/** The custom entry a pi-landstrip run appends to its parent session as it changes. */
export const LANDSTRIP_TASK_ENTRY = "landstrip.task";
/** pi-landstrip's folder under the agent dir: `sessions/pi-landstrip/<parent>/<task>/`. */
export const LANDSTRIP_SESSIONS_DIR = "pi-landstrip";
/** pi-landstrip's own nesting limit (MAX_DEPTH in its subagents.ts). */
const LANDSTRIP_MAX_DEPTH = 3;
/** Most runs one family lists; a runaway tree must not build an unbounded response. */
const MAX_AGENT_TASKS = 200;
/** One record is a few KB; a larger line is a torn write or not a record at all. */
const RECORD_LINE_MAX_BYTES = 1024 * 1024;
const HEADER_MAX_BYTES = 64 * 1024;
const MAX_CACHED_TASK_FILES = 256;
const MAX_CACHED_CHILD_FILES = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

type TaskState = "queued" | "running" | "completed" | "error" | "cancelled" | "interrupted";

const TASK_STATES = new Set<string>(["queued", "running", "completed", "error", "cancelled", "interrupted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One run as pi-landstrip persisted it; only the fields the switcher reads. */
export interface LandstripTaskRecord {
  id: string;
  parentSessionId: string;
  agent: string;
  description: string;
  state: TaskState;
  depth: number;
  deleted: boolean;
  sessionFile?: string;
  sessionDir?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** One run with the child session it wrote, as the Agents switcher lists it. */
export interface LandstripAgentTask {
  record: LandstripTaskRecord;
  status: SubagentSessionStatus;
  /** The child session's catalogue row, read from its own file. */
  info: ScannedSessionInfo;
}

export function landstripSessionsRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "sessions", LANDSTRIP_SESSIONS_DIR);
}

/** One run's folder, or null for an id that could address a path outside it. */
export function landstripTaskDir(parentSessionId: string, taskId: string, agentDir = getAgentDir()): string | null {
  if (!SESSION_ID_PATTERN.test(parentSessionId) || !SESSION_ID_PATTERN.test(taskId)) return null;
  return join(landstripSessionsRoot(agentDir), parentSessionId, taskId);
}

/** The switcher's status for one run's state. */
export function landstripTaskStatus(state: TaskState): SubagentSessionStatus {
  switch (state) {
    case "queued": return "queued";
    case "running": return "running";
    case "completed": return "completed";
    case "error": return "failed";
    case "cancelled": return "aborted";
    default: return "interrupted";
  }
}

/**
 * One `landstrip.task` entry's run, or null for anything else: another custom
 * entry, a background shell task (not an agent), or a malformed record.
 */
export function readLandstripTaskEntry(entry: unknown): LandstripTaskRecord | null {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== LANDSTRIP_TASK_ENTRY) return null;
  const data = entry.data;
  if (!isRecord(data)) return null;
  // `kind: "command"` runs a sandboxed shell command in the background; it has a
  // task folder and an output file but no child session, and is not an agent.
  if (data.kind === "command" || typeof data.command === "string") return null;
  if (typeof data.id !== "string" || !SESSION_ID_PATTERN.test(data.id)) return null;
  const parentSessionId = typeof data.parentSessionId === "string" ? data.parentSessionId : "";
  if (!SESSION_ID_PATTERN.test(parentSessionId)) return null;
  const state = typeof data.state === "string" && TASK_STATES.has(data.state) ? data.state as TaskState : "completed";
  return {
    id: data.id,
    parentSessionId,
    agent: typeof data.agent === "string" ? data.agent : "",
    description: typeof data.description === "string" ? data.description : "",
    state,
    depth: typeof data.depth === "number" && Number.isSafeInteger(data.depth) && data.depth >= 0 ? data.depth : 0,
    deleted: data.deleted === true,
    ...(typeof data.sessionFile === "string" && data.sessionFile ? { sessionFile: data.sessionFile } : {}),
    ...(typeof data.sessionDir === "string" && data.sessionDir ? { sessionDir: data.sessionDir } : {}),
    ...(typeof data.startedAt === "number" && Number.isFinite(data.startedAt) ? { startedAt: data.startedAt } : {}),
    ...(typeof data.finishedAt === "number" && Number.isFinite(data.finishedAt) ? { finishedAt: data.finishedAt } : {}),
  };
}

/** The session id in a session file's header line, read bounded; null when absent. */
async function readSessionHeaderId(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(HEADER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header: unknown = JSON.parse(firstLine.replace(/\r$/, ""));
    if (!isRecord(header) || header.type !== "session") return null;
    return typeof header.id === "string" && SESSION_ID_PATTERN.test(header.id) ? header.id : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Where a pi-landstrip child session lives, for an id the catalogue cannot
 * resolve (`resolveSessionPath`, so the child opens in the chat, a tab and the
 * stats route like any other session). Null when no run wrote that id.
 */
export async function findLandstripSessionPath(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = landstripSessionsRoot();
  let parents;
  try {
    parents = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  let match: string | null = null;
  for (const parent of parents) {
    if (!parent.isDirectory()) continue;
    const parentDir = join(root, parent.name);
    let tasks;
    try {
      tasks = await readdir(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const taskDir = join(parentDir, task.name);
      let files;
      try {
        files = await readdir(taskDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(suffix)) continue;
        const candidate = join(taskDir, file);
        // The name is only a hint: the header is authoritative.
        if (await readSessionHeaderId(candidate) !== sessionId) continue;
        // Never choose between duplicates; the caller falls back to a miss.
        if (match && match !== candidate) return null;
        match = candidate;
      }
    }
  }
  return match;
}

/**
 * How recent the last write to a session must be for pi-landstrip to count as
 * still working on it. A run rewrites its `landstrip.task` record on every tool
 * boundary and every turn end, so this much silence means it finished or died.
 */
export const LANDSTRIP_BUSY_WINDOW_MS = 10 * 60 * 1000;

/** Whether pi-landstrip has ever written a run for this session. */
function hasLandstripRuns(sessionId: string, agentDir = getAgentDir()): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  try {
    return statSync(join(landstripSessionsRoot(agentDir), sessionId)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether pi-landstrip is still working on this session, answered synchronously
 * and cheaply because pi-web's idle timer asks it on its own clock: a run appends
 * its record to the session file as it goes, from this pi or another one, so a
 * file written moments ago has a run behind it. A "busy" answer only postpones
 * eviction: the next check sees the same silence and lets the session go.
 */
export function landstripSessionBusy(
  session: { sessionId?: string; sessionFile?: string },
  now = Date.now(),
): boolean {
  const { sessionId, sessionFile } = session;
  if (!sessionId || !sessionFile || !hasLandstripRuns(sessionId)) return false;
  try {
    return now - statSync(sessionFile).mtimeMs < LANDSTRIP_BUSY_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Whether a path is inside pi-landstrip's own folder (a run's child session).
 * A record is just a line in a session file, so a path it carries is not
 * trusted to point anywhere a person could not have written it.
 */
export function isLandstripSessionFile(candidate: string): boolean {
  const root = resolvePath(landstripSessionsRoot());
  const target = resolvePath(candidate);
  const relativePath = relative(root, target);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/** A file the record names, if it is a session file where pi-landstrip writes them. */
async function namedSessionFile(candidate: string | undefined): Promise<string | undefined> {
  if (!candidate || !candidate.endsWith(".jsonl") || !isLandstripSessionFile(candidate)) return undefined;
  try {
    return (await stat(candidate)).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** The task's child session file: the record's own, else the newest `.jsonl` in its folder. */
async function resolveChildSessionFile(record: LandstripTaskRecord): Promise<string | undefined> {
  const named = await namedSessionFile(record.sessionFile);
  if (named) return named;
  const dirs = [...new Set([
    record.sessionDir && isLandstripSessionFile(record.sessionDir) ? record.sessionDir : undefined,
    landstripTaskDir(record.parentSessionId, record.id),
  ])].filter((dir): dir is string => Boolean(dir));
  for (const dir of dirs) {
    try {
      const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
      const candidates = await Promise.all(files.map(async (name) => {
        const path = join(dir, name);
        try {
          return { path, mtime: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }));
      const newest = candidates
        .flatMap((candidate) => candidate ? [candidate] : [])
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) return newest.path;
    } catch {
      // Missing or unreadable task folder: the next candidate.
    }
  }
  return undefined;
}

interface RecordCacheEntry {
  fingerprint: string;
  records: LandstripTaskRecord[];
}

interface ChildInfoCacheEntry {
  fingerprint: string;
  info: ScannedSessionInfo | null;
}

declare global {
  var __piWebLandstripTaskCache: Map<string, RecordCacheEntry> | undefined;
  var __piWebLandstripChildCache: Map<string, ChildInfoCacheEntry> | undefined;
}

function recordCache(): Map<string, RecordCacheEntry> {
  if (!globalThis.__piWebLandstripTaskCache) globalThis.__piWebLandstripTaskCache = new Map();
  return globalThis.__piWebLandstripTaskCache;
}

function childCache(): Map<string, ChildInfoCacheEntry> {
  if (!globalThis.__piWebLandstripChildCache) globalThis.__piWebLandstripChildCache = new Map();
  return globalThis.__piWebLandstripChildCache;
}

/**
 * A child session's row, kept until its file changes. The switcher polls a
 * running run, and its file grows on every append: a re-read of an unchanged
 * file must cost a stat, not another parse of the transcript.
 */
async function childSessionInfo(filePath: string): Promise<ScannedSessionInfo | null> {
  const fingerprint = fileFingerprint(filePath);
  const cache = childCache();
  if (!fingerprint) {
    cache.delete(filePath);
    return null;
  }
  const cached = cache.get(filePath);
  if (cached && cached.fingerprint === fingerprint) {
    // LRU touch: one read walks every child of a family.
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.info;
  }

  const info = await scanSessionFileInfo(filePath);
  cache.delete(filePath);
  cache.set(filePath, { fingerprint, info });
  while (cache.size > MAX_CACHED_CHILD_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return info;
}

/** A parent session's records, kept until the file changes: a family polls this. */
function cacheRecords(filePath: string, entry: RecordCacheEntry): LandstripTaskRecord[] {
  const cache = recordCache();
  cache.delete(filePath);
  cache.set(filePath, entry);
  while (cache.size > MAX_CACHED_TASK_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry.records;
}

/** Last record per run in the entries a live session holds. */
export function readLandstripTaskRecordsFromEntries(entries: readonly unknown[]): LandstripTaskRecord[] {
  const byId = new Map<string, LandstripTaskRecord>();
  for (const entry of entries) {
    const record = readLandstripTaskEntry(entry);
    if (!record) continue;
    if (record.deleted) byId.delete(record.id);
    else byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * Stream one session file for its `landstrip.task` entries (the last state of a
 * run wins, a deleted run drops out). Only lines naming the entry are parsed.
 */
async function scanTaskRecords(filePath: string): Promise<LandstripTaskRecord[]> {
  const byId = new Map<string, LandstripTaskRecord>();
  const take = (line: string) => {
    if (!line.includes(LANDSTRIP_TASK_ENTRY)) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const record = readLandstripTaskEntry(entry);
    if (!record) return;
    if (record.deleted) byId.delete(record.id);
    else byId.set(record.id, record);
  };

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1 << 16 });
    let buffer = "";
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        take(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      // A torn or enormous line is dropped rather than buffered further.
      if (buffer.length > RECORD_LINE_MAX_BYTES) buffer = "";
    });
    stream.on("end", () => {
      if (buffer) take(buffer.replace(/\r$/, ""));
      resolve();
    });
    stream.on("error", (error) => reject(error));
  });

  return [...byId.values()];
}

function fileFingerprint(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

/** A session's runs: its live entries when it runs here, else its file (cached by size+mtime). */
export async function readLandstripTaskRecords(options: {
  sessionFile?: string;
  entries?: readonly unknown[];
}): Promise<LandstripTaskRecord[]> {
  if (options.entries) return readLandstripTaskRecordsFromEntries(options.entries);
  const filePath = options.sessionFile;
  if (!filePath) return [];

  const fingerprint = fileFingerprint(filePath);
  if (!fingerprint) return [];
  const cached = recordCache().get(filePath);
  if (cached && cached.fingerprint === fingerprint) {
    // LRU touch: one read walks every child of a family.
    recordCache().delete(filePath);
    recordCache().set(filePath, cached);
    return cached.records;
  }
  try {
    const records = await scanTaskRecords(filePath);
    return cacheRecords(filePath, { fingerprint, records });
  } catch {
    return [];
  }
}

/**
 * Every run the session (and the runs it spawned, up to pi-landstrip's own
 * nesting limit) started, with the child session each one wrote. A run whose
 * child file is gone is left out: there is nothing to open or count.
 */
export async function listLandstripAgents(options: {
  sessionId: string;
  sessionFile?: string;
  entries?: readonly unknown[];
}): Promise<LandstripAgentTask[]> {
  const agents: LandstripAgentTask[] = [];
  const seenTasks = new Set<string>();
  const seenSessions = new Set<string>([options.sessionId]);
  const queue = [{ sessionId: options.sessionId, sessionFile: options.sessionFile, entries: options.entries }];

  while (queue.length > 0 && agents.length < MAX_AGENT_TASKS) {
    const current = queue.shift()!;
    const records = await readLandstripTaskRecords({ sessionFile: current.sessionFile, entries: current.entries });
    for (const record of records) {
      if (agents.length >= MAX_AGENT_TASKS) break;
      // A fork (and a side chat) copies its source's entries, `landstrip.task`
      // records included; the runs stay the source session's (as pi-landstrip's
      // own restore() decides).
      if (record.parentSessionId !== current.sessionId) continue;
      if (record.deleted || seenTasks.has(record.id)) continue;
      if (record.depth > LANDSTRIP_MAX_DEPTH) continue;
      const sessionFile = await resolveChildSessionFile(record);
      if (!sessionFile) continue;
      const info = await childSessionInfo(sessionFile);
      if (!info || seenSessions.has(info.id)) continue;
      seenTasks.add(record.id);
      seenSessions.add(info.id);
      agents.push({ record, status: landstripTaskStatus(record.state), info });
      // A child that ran its own subagents keeps their records in its own file.
      if (record.depth < LANDSTRIP_MAX_DEPTH) {
        queue.push({ sessionId: info.id, sessionFile, entries: undefined });
      }
    }
  }

  return agents.sort((a, b) => (
    (a.record.startedAt ?? a.info.created.getTime()) - (b.record.startedAt ?? b.info.created.getTime())
  ));
}
