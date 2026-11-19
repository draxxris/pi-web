import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const compareStart = source.indexOf("function sameLandstripRows(");
const compareEnd = source.indexOf("\n// pi's built-in tools", compareStart);
const mergeStart = source.indexOf("  const landstripRows =");
const mergeEnd = source.indexOf("  const landstripLoadedForRef =", mergeStart);
assert.ok(compareStart >= 0 && compareEnd > compareStart && mergeStart >= 0 && mergeEnd > mergeStart);
const compare = stripTypeScriptTypes(source.slice(compareStart, compareEnd));
const merge = stripTypeScriptTypes(source.slice(mergeStart, mergeEnd));
const { getAgentStripMembers } = await createJiti(import.meta.url).import("../lib/session-family.ts");

function row(id, created, status = "completed", name = id) {
  return { id, created, modified: created, name, messageCount: 1, relation: {
    kind: "subagent", parentSessionId: "main", profile: "pawn", description: id, status,
  } };
}

test("landstrip row comparison notices a rename without a message change", () => {
  const same = vm.runInNewContext(`${compare}\nsameLandstripRows`);
  const original = row("child", "2026-01-02");
  assert.equal(same([original], [{ ...original }]), true);
  assert.equal(same([original], [{ ...original, name: "Renamed" }]), false);
  assert.equal(same([original], [{ ...original, relation: { ...original.relation, status: "running" } }]), false);
});

test("the strip and switcher share landstrip siblings and keep polling while visible", () => {
  const root = { id: "main", created: "2026-01-01" };
  const selected = row("one", "2026-01-02");
  const latest = row("one", "2026-01-02", "completed", "Renamed");
  const running = row("two", "2026-01-03", "running");
  const context = vm.createContext({
    activeSessionFamily: { root, subagents: [selected] }, selectedSession: selected,
    sessionCatalog: [root], landstripRootId: root.id,
    landstripAgents: { rootId: root.id, rows: [latest, running] },
    runningSessionIds: new Set(),
    NO_LANDSTRIP_AGENTS: [], agentStripLocked: false, activeTopPanel: null,
    useMemo: (fn) => fn(), getAgentStripMembers,
  });
  const result = vm.runInContext(`${merge}\n({ familySubagents, agentStripMembers, landstripRunningIds, landstripLive })`, context);
  assert.deepEqual(Array.from(result.familySubagents, (item) => item.id), ["one", "two"]);
  assert.equal(result.familySubagents[0].name, "Renamed");
  assert.deepEqual(Array.from(result.agentStripMembers, (item) => item.id), ["two"]);
  assert.deepEqual(Array.from(result.landstripRunningIds), ["two"]);
  assert.equal(result.landstripLive, true);

  // A visible strip keeps watching even after all external runs finish.
  context.landstripAgents = { rootId: root.id, rows: [latest, { ...running, relation: { ...running.relation, status: "completed" } }] };
  const stopped = vm.runInContext(`${merge}\n({ agentStripMembers, landstripRunningIds, landstripLive })`, vm.createContext({ ...context }));
  assert.deepEqual(Array.from(stopped.agentStripMembers, (item) => item.id), []);
  assert.equal(stopped.landstripRunningIds.size, 0);
  assert.equal(stopped.landstripLive, true);
});
