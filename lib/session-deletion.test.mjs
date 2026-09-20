import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionDeletionPlan } = await jiti.import("./session-deletion.ts");

test("deletes marked sub-agent descendants and preserves ordinary forks", () => {
  const records = [
    { id: "root", path: "/sessions/root.jsonl", isSubagent: false },
    { id: "fork", path: "/sessions/fork.jsonl", parentPath: "/sessions/root.jsonl", isSubagent: false },
    { id: "sub", path: "/sessions/sub.jsonl", parentPath: "/sessions/root.jsonl", isSubagent: true },
    { id: "nested-sub", path: "/sessions/nested-sub.jsonl", parentPath: "/sessions/sub.jsonl", isSubagent: true },
    { id: "fork-from-sub", path: "/sessions/fork-from-sub.jsonl", parentPath: "/sessions/sub.jsonl", isSubagent: false },
    { id: "sub-under-fork", path: "/sessions/sub-under-fork.jsonl", parentPath: "/sessions/fork.jsonl", isSubagent: true },
  ];

  const plan = buildSessionDeletionPlan(records, "/sessions/root.jsonl");
  assert.deepEqual(
    plan.deleteRecords.map((record) => record.id).sort(),
    ["nested-sub", "root", "sub", "sub-under-fork"],
  );
  assert.deepEqual(
    plan.reparent.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "/sessions/fork-from-sub.jsonl", parentPath: undefined },
      { path: "/sessions/fork.jsonl", parentPath: undefined },
    ],
  );
});

test("keeps ordinary fork descendants attached when deleting a non-root parent", () => {
  const records = [
    { id: "grandparent", path: "/sessions/grandparent.jsonl", isSubagent: false },
    { id: "parent", path: "/sessions/parent.jsonl", parentPath: "/sessions/grandparent.jsonl", isSubagent: false },
    { id: "fork", path: "/sessions/fork.jsonl", parentPath: "/sessions/parent.jsonl", isSubagent: false },
    { id: "sub", path: "/sessions/sub.jsonl", parentPath: "/sessions/parent.jsonl", isSubagent: true },
  ];

  const plan = buildSessionDeletionPlan(records, "/sessions/parent.jsonl");
  assert.deepEqual(plan.deleteRecords.map((record) => record.id).sort(), ["parent", "sub"]);
  assert.deepEqual(plan.reparent, [{ path: "/sessions/fork.jsonl", parentPath: "/sessions/grandparent.jsonl" }]);
});
