import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const streamSource = await readFile(new URL("../../../lib/session-file-events.ts", import.meta.url), "utf8");

test("persisted-session events use a file watcher instead of starting another AgentSession", () => {
  assert.match(routeSource, /createSessionFileEventStream\(req, id, filePath\)/);
  assert.match(routeSource, /resolveSessionPath\(id\)/);
  assert.doesNotMatch(routeSource, /startRpcSession/);
  assert.match(streamSource, /fs\.watch\(watchedDirectory/);
  assert.match(streamSource, /send\("session_changed"/);
  assert.match(streamSource, /samePath\(/);
});
