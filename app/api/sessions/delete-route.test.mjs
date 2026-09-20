import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");

test("session deletion distinguishes marked sub-agents from ordinary forks", () => {
  assert.match(source, /SessionManager\.listAll\(\)/);
  assert.match(source, /isSubagentSessionFile\(session\.path\)/);
  assert.match(source, /buildSessionDeletionPlan\(records, filePath, id/);
  assert.match(source, /stopRegisteredSubagentSessions\(deletedPaths/);
});
