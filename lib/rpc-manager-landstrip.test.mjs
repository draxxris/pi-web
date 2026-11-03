import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

const PARENT = "01a182ae-e63b-7246-ae2d-d812f9dc15e4";
const TASK = "1cee7800-4410-4bd6-810f-ccf3923d0656";
const CHILD = "01a182ee-8782-7009-8eb1-0217a6bdad15";

const header = (id, cwd) => ({ type: "session", version: 3, id, timestamp: "2026-10-28T13:24:22.716Z", cwd });
const userMessage = (id) => ({
  type: "message",
  id: `${id}-m`,
  parentId: null,
  timestamp: "2026-10-28T14:33:53.000Z",
  message: { role: "user", content: "Verify the rewrite", timestamp: 1793198033000 },
});

/** A live wrapper as the registry holds one, over a session file already written. */
function wrapper(sessionId, sessionFile, cwd) {
  const entries = [header(sessionId, cwd), userMessage(sessionId)];
  return {
    sessionId,
    cwd,
    sessionFile,
    isAlive: () => true,
    isRunning: () => false,
    inner: {
      sessionManager: {
        getHeader: () => header(sessionId, cwd),
        getEntries: () => entries,
        getSessionFile: () => sessionFile,
        getSessionName: () => undefined,
      },
    },
  };
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-rpc-landstrip-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeSession(file, id, cwd = "/work/alpha") {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${[header(id, cwd), userMessage(id)].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

test("a wrapper opened on a pi-landstrip child never becomes a catalogue row", async (t) => {
  const dir = await scratchAgentDir(t);
  const parentFile = await writeSession(join(dir, "sessions", "--work-alpha--", `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`), PARENT);
  const childFile = await writeSession(join(dir, "sessions", "pi-landstrip", PARENT, TASK, `2026-10-28T14-33-52-773Z_${CHILD}.jsonl`), CHILD);

  globalThis.__piSessions.set(PARENT, wrapper(PARENT, parentFile, "/work/alpha"));
  globalThis.__piSessions.set(CHILD, wrapper(CHILD, childFile, "/work/alpha"));

  // The child is a run the Agents switcher lists; listing it here would give it
  // no relation at all and a sidebar row of its own.
  assert.deepEqual(getRpcSessionInfos().map((session) => session.id), [PARENT]);
  // Deleting a project's sessions still sees every wrapper it holds.
  assert.deepEqual(
    getRpcSessionInfos({ includeTransient: true }).map((session) => session.id).sort(),
    [PARENT, CHILD].sort(),
  );
});

/** The wrapper's view of an SDK session: only what the idle path touches. */
function liveInner(sessionId, sessionFile) {
  return {
    sessionId,
    sessionFile,
    isBashRunning: false,
    isStreaming: false,
    extensionRunner: { async emit() {} },
    sessionManager: {
      getHeader: () => header(sessionId, "/work/alpha"),
      getCwd: () => "/work/alpha",
      getEntries: () => [],
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
    },
    systemPrompt: "",
    agent: { state: {} },
    subscribe: () => () => {},
    dispose() {},
  };
}

test("the idle timer keeps a session pi-landstrip is writing to, and lets it go in silence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await scratchAgentDir(t);
  const parentFile = await writeSession(join(dir, "sessions", "--work-alpha--", `2026-10-28T13-24-22-716Z_${PARENT}.jsonl`), PARENT);
  // The run's folder is what makes this session pi-landstrip's to claim.
  await mkdir(join(dir, "sessions", "pi-landstrip", PARENT, TASK), { recursive: true });

  const wrapper = new AgentSessionWrapper(liveInner(PARENT, parentFile));
  t.after(() => wrapper.destroy());
  wrapper.start();

  // A run rewrote the session a moment ago: pi-web's own checks see an idle
  // session, the claim keeps the wrapper (and the worker behind it) alive.
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.isAlive(), true);

  // Its records stop: the same silence lets the next check reap it, so a claim
  // after a run died cannot pin the session.
  const stale = (Date.now() - 20 * 60 * 1000) / 1000;
  await utimes(parentFile, stale, stale);
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.isAlive(), false);

  wrapper.destroy();
});
