import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getAgentStripMembers, getAgentsBadge, getSessionFamily, getSessionFamilyIncluding, listSessionFamilies } = await createJiti(import.meta.url).import("./session-family.ts");

function session(id, modified, relation) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
    ...(relation ? { relation } : {}),
  };
}

test("groups nested subagents under their main session and uses family activity for sorting", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "review", description: "Review", status: "running",
  });
  const newerRoot = session("newer-root", "2026-01-02T00:00:00.000Z");

  const families = listSessionFamilies([main, child, grandchild, newerRoot]);
  assert.deepEqual(families.map((family) => family.root.id), ["main", "newer-root"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["child", "grandchild"]);
  assert.equal(getSessionFamily([main, child, grandchild], "grandchild")?.root.id, "main");
});

test("does not promote orphaned or cyclic subagent metadata into the main session list", () => {
  const orphan = session("orphan", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "missing", profile: "explore", description: "Explore", status: "interrupted",
  });
  const a = session("a", "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "b", profile: "a", description: "A", status: "interrupted",
  });
  const b = session("b", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "a", profile: "b", description: "B", status: "interrupted",
  });

  assert.deepEqual(listSessionFamilies([orphan, a, b]), []);
  assert.equal(getSessionFamily([orphan, a, b], "orphan"), null);
});

test("a fork is a family of its own, and its subagents fold into it, not into its origin", () => {
  const origin = session("origin", "2026-01-01T00:00:00.000Z");
  const fork = session("fork", "2026-01-01T00:00:00.000Z", { kind: "fork", originSessionId: "origin" });
  const forkAgent = session("fork-agent", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "fork", profile: "explore", description: "Explore", status: "completed",
  });

  const families = listSessionFamilies([fork, origin, forkAgent]);
  assert.deepEqual(families.map((family) => family.root.id), ["fork", "origin"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["fork-agent"]);
  assert.deepEqual(families[1].subagents, []);
  assert.equal(getSessionFamily([fork, origin, forkAgent], "fork-agent")?.root.id, "fork");
});

test("the Agents badge counts running subagents while any runs, else all of them", () => {
  const subagents = ["a", "b", "c"].map((id) => session(id, "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: id, status: "completed",
  }));

  assert.deepEqual(getAgentsBadge(subagents, new Set()), { count: 3, running: false });
  // The main session and other families' runs do not count.
  assert.deepEqual(getAgentsBadge(subagents, new Set(["main", "elsewhere"])), { count: 3, running: false });
  assert.deepEqual(getAgentsBadge(subagents, new Set(["b"])), { count: 1, running: true });
  assert.deepEqual(getAgentsBadge(subagents, new Set(["a", "c", "main"])), { count: 2, running: true });
});

test("the Agents strip shows while the main chat holds a non-root member, listing only active members by creation", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const later = session("later", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Later", status: "running",
  });
  const queued = session("queued", "2026-01-03T12:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Queued", status: "queued",
  });
  const side = session("side", "2026-01-02T00:00:00.000Z", { kind: "side", parentSessionId: "main" });
  const nested = session("nested", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "later", profile: "plan", description: "Nested", status: "completed",
  });
  const sessions = [main, later, queued, side, nested];
  const running = new Set(["later"]);

  // The root and sessions outside the family show no strip.
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "main", running), null);
  assert.equal(getAgentStripMembers(null, "later", running), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "elsewhere", running), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), null, running), null);

  // A subagent, a nested one or a side chat in the main chat: only active members (running/queued), oldest first.
  for (const id of ["later", "queued", "side", "nested"]) {
    assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, id), id, running)?.map((item) => item.id), ["later", "queued"]);
    // The lock changes nothing there.
    assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, id), id, running, true)?.map((item) => item.id), ["later", "queued"]);
  }

  // With nothing active, viewing a finished child or idle side chat still shows the strip (empty members, for Main agent link).
  const finishedSessions = [main, { ...later, relation: { ...later.relation, status: "completed" } }, nested, side];
  assert.deepEqual(getAgentStripMembers(getSessionFamily(finishedSessions, "nested"), "nested", new Set()), []);
  assert.deepEqual(getAgentStripMembers(getSessionFamily(finishedSessions, "side"), "side", new Set()), []);
});

test("a locked Agents strip shows on the root too, once the family has an active member", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const done = session("done", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Done", status: "completed",
  });
  const active = session("active", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Active", status: "running",
  });
  const alone = session("alone", "2026-01-04T00:00:00.000Z");
  const sessions = [main, done, active, alone];

  assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, "main"), "main", new Set(["active"]), true)?.map((item) => item.id), ["active"]);
  // Only finished members or no members at all: nothing to list on the root, locked or not.
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "main", new Set(), true), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "alone"), "alone", new Set(), true), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "elsewhere", new Set(["active"]), true), null);
});

test("a run the list does not hold joins its parent's family through its own row", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const listed = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  // pi-landstrip's rows reach the page without the catalogue (their files sit
  // below the folders it scans), so the family comes from the parent they name.
  const unlisted = session("landstrip-run", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "pawn", description: "Verify", status: "running",
  });

  const family = getSessionFamilyIncluding([main, listed], unlisted);
  assert.equal(family?.root.id, "main");
  assert.deepEqual(family?.subagents.map((item) => item.id), ["child", "landstrip-run"]);
  // A listed session keeps the family it was already in.
  assert.deepEqual(getSessionFamilyIncluding([main, listed], listed)?.subagents.map((item) => item.id), ["child"]);
  // An orphan (its parent is gone) and no selection have no family.
  assert.equal(getSessionFamilyIncluding([main, listed], session("other", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "missing", profile: "pawn", description: "Orphan", status: "completed",
  })), null);
  assert.equal(getSessionFamilyIncluding([main, listed], null), null);
});

test("the Agents strip and badge work with an unlisted landstrip run in the family", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const side = session("side", "2026-01-03T00:00:00.000Z", { kind: "side", parentSessionId: "main" });
  const child = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  const run = session("landstrip-run", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "pawn", description: "Verify", status: "running",
  });
  const sessions = [main, side, child];
  const family = getSessionFamilyIncluding(sessions, run);
  assert.equal(family?.root.id, "main");
  assert.deepEqual(family?.subagents.map((item) => item.id), ["side", "child", "landstrip-run"]);
  assert.deepEqual(getAgentStripMembers(family, run.id, new Set([run.id]))?.map((item) => item.id), ["landstrip-run"]);
  assert.deepEqual(getAgentStripMembers(family, main.id, new Set([run.id]), true)?.map((item) => item.id), ["landstrip-run"]);
  assert.equal(getAgentStripMembers(family, main.id, new Set([run.id])), null);
  // Sorting the strip must not change the family, and selecting a row already
  // merged with the catalogue must not add it a second time.
  assert.deepEqual(family?.subagents.map((item) => item.id), ["side", "child", "landstrip-run"]);
  assert.deepEqual(getSessionFamilyIncluding([...sessions, run], run)?.subagents.map((item) => item.id), ["side", "child", "landstrip-run"]);
  assert.deepEqual(getAgentsBadge(family.subagents, new Set([run.id])), { count: 1, running: true });
  assert.deepEqual(getAgentsBadge(family.subagents, new Set()), { count: 3, running: false });
});
