import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  LANDSTRIP_BUSY_WINDOW_MS,
  landstripSessionBusy,
  findLandstripSessionPath,
  landstripTaskStatus,
  listLandstripAgents,
  readLandstripTaskEntry,
  readLandstripTaskRecordsFromEntries,
} = await jiti.import("./landstrip-subagents.ts");
const { resolveSessionPath } = await jiti.import("./session-reader.ts");

const PARENT = "01a182ae-e63b-7246-ae2d-d812f9dc15e4";
const FIRST_TASK = "1cee7800-4410-4bd6-810f-ccf3923d0656";
const SECOND_TASK = "138be3a1-deec-4194-ba61-43becb95585c";
const COMMAND_TASK = "2584fdef-9c58-4a1a-a95b-d051f4bd3906";
const FIRST_CHILD = "01a182ee-8782-7009-8eb1-0217a6bdad15";
const SECOND_CHILD = "01a182ee-8784-73e6-8d6b-dba3f1a020d2";

function taskEntry(data) {
  return { type: "custom", customType: "landstrip.task", id: `entry-${Math.random()}`, parentId: null, timestamp: "2026-10-28T14:33:35.246Z", data };
}

function subagentTask(overrides) {
  return taskEntry({
    version: 1,
    kind: "subagent",
    parentSessionId: PARENT,
    agent: "pawn",
    description: "Do the work",
    depth: 0,
    state: "running",
    ...overrides,
  });
}

function childSessionFile(id, cwd) {
  const header = { type: "session", version: 3, id, timestamp: "2026-10-28T14:33:52.773Z", cwd };
  const message = {
    type: "message",
    id: `${id}-m`,
    parentId: null,
    timestamp: "2026-10-28T14:33:53.000Z",
    message: { role: "user", content: "Verify the rewrite", timestamp: 1793198033000 },
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

/**
 * The layout pi-landstrip writes: its child sessions one folder below the
 * catalogue's, and the run records inside the parent session.
 */
async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-landstrip-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piWebLandstripTaskCache = undefined;
  globalThis.__piWebLandstripChildCache = undefined;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__piWebLandstripTaskCache = undefined;
    globalThis.__piWebLandstripChildCache = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const parentFile = join(dir, "sessions", "--work-alpha--", `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`);
  await mkdir(join(dir, "sessions", "--work-alpha--"), { recursive: true });
  return { dir, parentFile };
}

async function writeChild(dir, taskId, sessionId, cwd = "/work/alpha") {
  const taskDir = join(dir, "sessions", "pi-landstrip", PARENT, taskId);
  await mkdir(taskDir, { recursive: true });
  const file = join(taskDir, `2026-10-28T14-33-52-773Z_${sessionId}.jsonl`);
  await writeFile(file, childSessionFile(sessionId, cwd));
  return file;
}

async function writeParent(parentFile, entries) {
  const header = { type: "session", version: 3, id: PARENT, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" };
  await writeFile(parentFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("lists pi-landstrip runs as the switcher's subagent rows, with their child sessions", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  await writeChild(dir, SECOND_TASK, SECOND_CHILD);
  await writeParent(parentFile, [
    subagentTask({ id: FIRST_TASK, description: "Verify rewrite completeness", state: "queued", startedAt: 1 }),
    subagentTask({ id: FIRST_TASK, description: "Verify rewrite completeness", state: "completed", startedAt: 1, finishedAt: 2 }),
    subagentTask({ id: SECOND_TASK, agent: "pawn_high", description: "Re-verify", state: "error", startedAt: 3 }),
  ]);

  const agents = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((agent) => agent.record.id), [FIRST_TASK, SECOND_TASK]);
  assert.deepEqual(agents.map((agent) => agent.status), ["completed", "failed"]);
  assert.equal(agents[0].record.description, "Verify rewrite completeness");
  assert.equal(agents[1].record.agent, "pawn_high");
  assert.equal(agents[0].info.id, FIRST_CHILD);
  assert.equal(agents[0].info.cwd, "/work/alpha");
});

test("leaves out background shell tasks, deleted runs and runs without a child session", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  await writeParent(parentFile, [
    taskEntry({
      id: COMMAND_TASK,
      kind: "command",
      agent: "bash",
      command: "cargo test",
      description: "Run the tests",
      parentSessionId: PARENT,
      depth: 0,
      state: "completed",
      sessionDir: join(dir, "sessions", "pi-landstrip", PARENT, COMMAND_TASK),
    }),
    subagentTask({ id: FIRST_TASK, description: "Verify rewrite completeness" }),
    subagentTask({ id: SECOND_TASK, description: "Never started" }),
    subagentTask({ id: FIRST_TASK, description: "Verify rewrite completeness", deleted: true }),
    subagentTask({ id: FIRST_TASK, description: "Verify rewrite completeness again" }),
  ]);

  const agents = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.deepEqual(agents.map((agent) => agent.record.id), [FIRST_TASK]);
  assert.equal(agents[0].record.description, "Verify rewrite completeness again");
});

test("never follows a path a record names outside pi-landstrip's own folder", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  const outside = join(dir, "sessions", "--work-alpha--", "not-a-landstrip-session.jsonl");
  await writeFile(outside, childSessionFile(SECOND_CHILD, "/work/alpha"));
  const landstripRoot = join(dir, "sessions", "pi-landstrip");
  await writeParent(parentFile, [
    subagentTask({ id: SECOND_TASK, sessionFile: outside, sessionDir: join(dir, "sessions", "--work-alpha--") }),
    // The landstrip folder itself, its parent, and a folder instead of a file.
    subagentTask({ id: SECOND_TASK, sessionFile: landstripRoot }),
    subagentTask({ id: SECOND_TASK, sessionFile: join(landstripRoot, "..", "x.jsonl") }),
    subagentTask({ id: SECOND_TASK, sessionFile: join(landstripRoot, "not-a-session.txt") }),
    subagentTask({ id: FIRST_TASK }),
  ]);

  const agents = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.deepEqual(agents.map((agent) => agent.info.id), [FIRST_CHILD]);
});

test("reads a run's child session from its task folder when the record names none", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK })]);

  const agents = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].info.id, FIRST_CHILD);
});

test("lists the runs a child started with its own landstrip extension", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  const childFile = await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  const nestedTask = "43f32ee3-362e-4082-8862-8f394cdcdc5d";
  const nestedChild = "01a1830e-1871-72fb-94f9-c62e7d64f1ab";
  const nestedDir = join(dir, "sessions", "pi-landstrip", FIRST_CHILD, nestedTask);
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, `2026-10-28T15-08-21-490Z_${nestedChild}.jsonl`), childSessionFile(nestedChild, "/work/alpha"));
  await writeFile(childFile, `${childSessionFile(FIRST_CHILD, "/work/alpha")}${JSON.stringify(subagentTask({
    id: nestedTask,
    parentSessionId: FIRST_CHILD,
    depth: 1,
    description: "Nested run",
    state: "running",
  }))}\n`);
  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK, state: "running" })]);

  const agents = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.deepEqual(agents.map((agent) => agent.record.id), [FIRST_TASK, nestedTask]);
  assert.deepEqual(agents.map((agent) => agent.info.id), [FIRST_CHILD, nestedChild]);
  assert.equal(agents[1].record.description, "Nested run");
});

test("a fork's copied records stay the source session's runs", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  // Forking copies entries; pi-landstrip's own restore() reads a record only in
  // the session it names, so the runs are the source's, not the fork's.
  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK })]);

  const fork = await listLandstripAgents({ sessionId: "01a1a25c-957f-770e-b37c-f4d19a4519ec", sessionFile: parentFile });
  assert.deepEqual(fork, []);
  const source = await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile });
  assert.deepEqual(source.map((agent) => agent.info.id), [FIRST_CHILD]);
});

test("reads the runs a live session holds in its own entries", async () => {
  const records = readLandstripTaskRecordsFromEntries([
    { type: "message", id: "m1" },
    subagentTask({ id: FIRST_TASK, state: "queued" }),
    subagentTask({ id: FIRST_TASK, state: "running" }),
  ]);
  assert.deepEqual(records.map((record) => [record.id, record.state]), [[FIRST_TASK, "running"]]);
});

test("maps every pi-landstrip state onto a subagent status", () => {
  assert.deepEqual(
    ["queued", "running", "completed", "error", "cancelled", "interrupted"].map(landstripTaskStatus),
    ["queued", "running", "completed", "failed", "aborted", "interrupted"],
  );
});

test("ignores entries that are not subagent records", () => {
  assert.equal(readLandstripTaskEntry({ type: "custom", customType: "pi-web:subagent", data: { id: FIRST_TASK } }), null);
  assert.equal(readLandstripTaskEntry({ type: "message" }), null);
  assert.equal(readLandstripTaskEntry(subagentTask({ id: "../../escape" })), null);
  assert.equal(readLandstripTaskEntry(subagentTask({ parentSessionId: "" })), null);
});

test("resolves a pi-landstrip child session by id, for the chat, a tab and the stats route", async (t) => {
  const { dir } = await scratchAgentDir(t);
  const childFile = await writeChild(dir, FIRST_TASK, FIRST_CHILD);

  assert.equal(await findLandstripSessionPath(FIRST_CHILD), childFile);
  assert.equal(await findLandstripSessionPath(SECOND_CHILD), null);
  assert.equal(await resolveSessionPath(FIRST_CHILD), childFile);
});

test("reuses an unchanged parent file's records and re-reads a changed one", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK })]);

  assert.deepEqual(
    (await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile })).map((agent) => agent.info.id),
    [FIRST_CHILD],
  );
  // An unreadable file whose size and mtime are unchanged is answered from the
  // records already read: the switcher polls this, the CLI owns the file.
  await chmod(parentFile, 0o000);
  try {
    assert.deepEqual(
      (await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile })).map((agent) => agent.info.id),
      [FIRST_CHILD],
    );
  } finally {
    await chmod(parentFile, 0o600);
  }

  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK }), subagentTask({ id: SECOND_TASK })]);
  await writeChild(dir, SECOND_TASK, SECOND_CHILD);
  assert.deepEqual(
    (await listLandstripAgents({ sessionId: PARENT, sessionFile: parentFile })).map((agent) => agent.info.id),
    [FIRST_CHILD, SECOND_CHILD],
  );
});

test("a session counts as busy only while pi-landstrip is writing to it", async (t) => {
  const { dir, parentFile } = await scratchAgentDir(t);
  await writeChild(dir, FIRST_TASK, FIRST_CHILD);
  await writeParent(parentFile, [subagentTask({ id: FIRST_TASK })]);

  // Fresh writes with a run folder behind them: a run is in progress.
  assert.equal(landstripSessionBusy({ sessionId: PARENT, sessionFile: parentFile }), true);
  // A session pi-landstrip never ran from is never busy, however fresh its file is.
  assert.equal(landstripSessionBusy({ sessionId: SECOND_TASK, sessionFile: parentFile }), false);
  assert.equal(landstripSessionBusy({ sessionFile: parentFile }), false);
  assert.equal(landstripSessionBusy({ sessionId: PARENT }), false);

  // Records stop arriving: the silence itself ends the claim, so the next idle
  // check lets the session go instead of pinning it forever.
  const stale = (Date.now() - LANDSTRIP_BUSY_WINDOW_MS - 60_000) / 1000;
  await utimes(parentFile, stale, stale);
  assert.equal(landstripSessionBusy({ sessionId: PARENT, sessionFile: parentFile }), false);
  // A file that is gone is not a run either (a deleted session, a moved agent dir).
  assert.equal(landstripSessionBusy({ sessionId: PARENT, sessionFile: join(dir, "missing.jsonl") }), false);
});
