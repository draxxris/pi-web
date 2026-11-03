import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: landstripRoute } = await jiti.import("./[id]/landstrip/route.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

const PARENT = "01a182ae-e63b-7246-ae2d-d812f9dc15e4";
const TASK = "1cee7800-4410-4bd6-810f-ccf3923d0656";
const CHILD = "01a182ee-8782-7009-8eb1-0217a6bdad15";
const COMMAND_TASK = "2584fdef-9c58-4a1a-a95b-d051f4bd3906";

function get(id) {
  return landstripRoute(
    new Request(`http://localhost/api/sessions/${id}/landstrip`),
    { params: Promise.resolve({ id }) },
  );
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-landstrip-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  globalThis.__piWebLandstripTaskCache = undefined;
  globalThis.__piWebLandstripChildCache = undefined;
  // The path cache is global: an earlier test's temp folder must not answer.
  invalidateSessionPathCache(PARENT);
  invalidateSessionPathCache(CHILD);
  invalidateSessionListCache();
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    globalThis.__piWebLandstripTaskCache = undefined;
    globalThis.__piWebLandstripChildCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionPathCache(PARENT);
    invalidateSessionPathCache(CHILD);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function liveWrapper(sessionId, file, entries) {
  return {
    sessionId,
    cwd: "/work/alpha",
    sessionFile: file,
    isAlive: () => true,
    isRunning: () => false,
    inner: {
      sessionManager: {
        getHeader: () => ({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" }),
        getEntries: () => entries,
        getSessionFile: () => file,
        getSessionName: () => undefined,
      },
    },
  };
}

function task(data) {
  return JSON.stringify({
    type: "custom",
    customType: "landstrip.task",
    id: `entry-${Math.random()}`,
    parentId: null,
    timestamp: "2026-10-28T14:33:35.246Z",
    data: { version: 1, parentSessionId: PARENT, depth: 0, ...data },
  });
}

test("answers a session's pi-landstrip runs as subagent rows the switcher can open", async (t) => {
  const dir = await scratchAgentDir(t);
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  const taskDir = join(dir, "sessions", "pi-landstrip", PARENT, TASK);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: PARENT, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" })}\n${
      [task({ kind: "subagent", id: TASK, agent: "pawn", description: "Verify the rewrite", state: "running" }),
        // A background shell task has a folder but no child session.
        task({ kind: "command", id: COMMAND_TASK, agent: "bash", command: "cargo test", description: "Tests", state: "completed" })].join("\n")
    }\n`,
  );
  const childFile = join(taskDir, `2026-10-28T14-33-52-773Z_${CHILD}.jsonl`);
  await writeFile(childFile, [
    JSON.stringify({ type: "session", version: 3, id: CHILD, timestamp: "2026-10-28T14:33:52.773Z", cwd: "/work/alpha" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-28T14:33:53.000Z", message: { role: "user", content: "Verify the rewrite", timestamp: 1793198033000 } }),
  ].join("\n") + "\n");

  const res = await get(PARENT);
  assert.equal(res.status, 200);
  const { agents } = await res.json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, CHILD);
  assert.equal(agents[0].path, childFile);
  assert.equal(agents[0].cwd, "/work/alpha");
  assert.equal(agents[0].firstMessage, "Verify the rewrite");
  assert.deepEqual(agents[0].relation, {
    kind: "subagent",
    parentSessionId: PARENT,
    profile: "pawn",
    description: "Verify the rewrite",
    status: "running",
  });
  assert.equal(agents[0].projectRoot, "/work/alpha");
});

test("answers an empty list for a session with no pi-landstrip runs or an unknown id", async (t) => {
  const dir = await scratchAgentDir(t);
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: PARENT, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" })}\n`,
  );

  assert.deepEqual(await (await get(PARENT)).json(), { agents: [] });
  assert.deepEqual(await (await get("01a1a25c-957f-770e-b37c-f4d19a4519ec")).json(), { agents: [] });
});

test("reads the file, not a live wrapper's stale entries, while another process writes", async (t) => {
  const dir = await scratchAgentDir(t);
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  const taskDir = join(dir, "sessions", "pi-landstrip", PARENT, TASK);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(taskDir, { recursive: true });
  const parentFile = join(sessionsDir, `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`);
  // The file has the run's last state; the wrapper opened before that append.
  await writeFile(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: PARENT, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" })}\n${
      task({ kind: "subagent", id: TASK, agent: "pawn", description: "Verify the rewrite", state: "completed" })
    }\n`,
  );
  await writeFile(join(taskDir, `2026-10-28T14-33-52-773Z_${CHILD}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: CHILD, timestamp: "2026-10-28T14:33:52.773Z", cwd: "/work/alpha" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-28T14:33:53.000Z", message: { role: "user", content: "Verify the rewrite", timestamp: 1793198033000 } }),
  ].join("\n") + "\n");
  globalThis.__piSessions.set(PARENT, liveWrapper(PARENT, parentFile, [
    JSON.parse(task({ kind: "subagent", id: TASK, agent: "pawn", description: "Verify the rewrite", state: "running" })),
  ]));

  const { agents } = await (await get(PARENT)).json();
  assert.equal(agents.length, 1);
  // ... and the live wrapper was opened by pi-web itself, so no run started here.
  assert.equal(agents[0].relation.status, "completed");
});

test("a run a landstrip child nested under itself still hangs off the queried session", async (t) => {
  const dir = await scratchAgentDir(t);
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  const taskDir = join(dir, "sessions", "pi-landstrip", PARENT, TASK);
  const nestedTask = "43f32ee3-362e-4082-8862-8f394cdcdc5d";
  const nestedChild = "01a1830e-1871-72fb-94f9-c62e7d64f1ab";
  const nestedDir = join(dir, "sessions", "pi-landstrip", CHILD, nestedTask);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(taskDir, { recursive: true });
  await mkdir(nestedDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: PARENT, timestamp: "2026-10-28T13:24:22.716Z", cwd: "/work/alpha" })}\n${
      task({ kind: "subagent", id: TASK, agent: "pawn", description: "Verify the rewrite", state: "running" })
    }\n`,
  );
  const childFile = join(taskDir, `2026-10-28T14-33-52-773Z_${CHILD}.jsonl`);
  await writeFile(childFile, [
    JSON.stringify({ type: "session", version: 3, id: CHILD, timestamp: "2026-10-28T14:33:52.773Z", cwd: "/work/alpha" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-28T14:33:53.000Z", message: { role: "user", content: "Verify the rewrite", timestamp: 1793198033000 } }),
    JSON.stringify({
      type: "custom",
      customType: "landstrip.task",
      id: "nested",
      parentId: "m1",
      timestamp: "2026-10-28T15:08:21.490Z",
      data: { version: 1, kind: "subagent", id: nestedTask, parentSessionId: CHILD, agent: "seeker", description: "Nested run", depth: 1, state: "completed" },
    }),
  ].join("\n") + "\n");
  await writeFile(join(nestedDir, `2026-10-28T15-08-21-490Z_${nestedChild}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: nestedChild, timestamp: "2026-10-28T15:08:21.490Z", cwd: "/work/alpha" }),
    JSON.stringify({ type: "message", id: "n1", parentId: null, timestamp: "2026-10-28T15:08:22.000Z", message: { role: "user", content: "Nested run", timestamp: 1793198502000 } }),
  ].join("\n") + "\n");

  const { agents } = await (await get(PARENT)).json();
  assert.deepEqual(agents.map((agent) => agent.id), [CHILD, nestedChild]);
  // The switcher groups rows by this id: the queried session, never an unlisted child.
  assert.deepEqual(agents.map((agent) => agent.relation.parentSessionId), [PARENT, PARENT]);
});
