import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLiveSubagentSession,
  getLiveSubagentSessionIds,
  getUnmanagedSubagentSessionIds,
  stopRegisteredSubagentSessions,
} = await jiti.import("./subagent-session-lifecycle.ts");

test("lists live sub-agent session ids from the shared registry", () => {
  const key = Symbol.for("pi.subagents.interactionSessions");
  const previous = globalThis[key];
  globalThis[key] = new Map([
    ["sub-1", { origin: "subagent", sessionFile: "/sessions/sub1.jsonl" }],
    ["sub-2", { origin: "subagent" }],
    ["parent-ish", { origin: "parent" }],
    [123, { origin: "subagent" }],
  ]);

  try {
    assert.deepEqual(getLiveSubagentSessionIds().sort(), ["sub-1", "sub-2"]);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }

  globalThis[key] = undefined;
  try {
    assert.deepEqual(getLiveSubagentSessionIds(), []);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("exposes the live session handle and flags only unadoptable runs", () => {
  const key = Symbol.for("pi.subagents.interactionSessions");
  const previous = globalThis[key];
  const live = { sessionId: "sub-1", prompt: () => undefined, steer: () => undefined };
  globalThis[key] = new Map([
    ["sub-1", { origin: "subagent", sessionFile: "/sessions/sub1.jsonl", session: live }],
    ["sub-2", { origin: "subagent", sessionFile: "/sessions/sub2.jsonl" }],
    // Malformed handle: not a usable AgentSession, so it stays read-only.
    ["sub-3", { origin: "subagent", session: { sessionId: "sub-3" } }],
    ["parent-ish", { origin: "parent", session: live }],
  ]);

  try {
    assert.equal(getLiveSubagentSession("sub-1"), live);
    assert.equal(getLiveSubagentSession("sub-2"), null);
    assert.equal(getLiveSubagentSession("sub-3"), null);
    assert.equal(getLiveSubagentSession("parent-ish"), null);
    assert.deepEqual(getUnmanagedSubagentSessionIds().sort(), ["sub-2", "sub-3"]);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("stops only matching active sub-agent sessions through the shared registry", async () => {
  const key = Symbol.for("pi.subagents.interactionSessions");
  const previous = globalThis[key];
  const stopped = [];
  globalThis[key] = new Map([
    ["matching", { origin: "subagent", sessionFile: "/sessions/sub.jsonl", stop: async (reason) => stopped.push(["matching", reason]) }],
    ["other", { origin: "subagent", sessionFile: "/sessions/other.jsonl", stop: async () => stopped.push(["other"]) }],
  ]);

  try {
    await stopRegisteredSubagentSessions(["/sessions/sub.jsonl"], "parent deleted");
    assert.deepEqual(stopped, [["matching", "parent deleted"]]);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});
