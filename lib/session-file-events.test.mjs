import assert from "node:assert/strict";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionFileEventStream } = await jiti.import("./session-file-events.ts");
const decoder = new TextDecoder();

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading session event")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseEvent(chunk) {
  const text = decoder.decode(chunk.value);
  const match = text.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/);
  assert.ok(match, `Unexpected SSE payload: ${text}`);
  return { name: match[1], data: JSON.parse(match[2]) };
}

test("publishes persisted session changes without creating an AgentSession", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-session-events-"));
  const filePath = join(directory, "session.jsonl");
  await writeFile(filePath, "header\n");
  const abortController = new AbortController();

  try {
    const stream = createSessionFileEventStream(
      new Request("http://localhost/api/sessions/session-id/events", { signal: abortController.signal }),
      "session-id",
      filePath,
    );
    const reader = stream.getReader();

    const connected = parseEvent(await readWithin(reader));
    assert.deepEqual(connected, { name: "connected", data: { sessionId: "session-id" } });

    await appendFile(filePath, "record\n");
    const changed = parseEvent(await readWithin(reader));
    assert.equal(changed.name, "session_changed");
    assert.equal(changed.data.sessionId, "session-id");
    assert.equal(changed.data.exists, true);
    assert.equal(typeof changed.data.size, "number");

    abortController.abort();
    assert.equal((await readWithin(reader)).done, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
