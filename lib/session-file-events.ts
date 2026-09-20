import fs from "node:fs";
import path from "node:path";
import { samePath } from "./paths";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CHANGE_DEBOUNCE_MS = 25;

interface SessionFileSignature {
  exists: boolean;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  size: number;
}

function readSignature(filePath: string): SessionFileSignature {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { exists: false, mtimeMs: 0, ctimeMs: 0, ino: 0, size: 0 };
    }
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      size: stat.size,
    };
  } catch {
    return { exists: false, mtimeMs: 0, ctimeMs: 0, ino: 0, size: 0 };
  }
}

function signatureChanged(previous: SessionFileSignature, next: SessionFileSignature): boolean {
  return previous.exists !== next.exists
    || previous.mtimeMs !== next.mtimeMs
    || previous.ctimeMs !== next.ctimeMs
    || previous.ino !== next.ino
    || previous.size !== next.size;
}

export function createSessionFileEventStream(
  req: Request,
  sessionId: string,
  filePath: string,
): ReadableStream<Uint8Array> {
  let closeStream: (closeController: boolean) => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const watchedDirectory = path.dirname(filePath);
      let closed = false;
      let watcher: fs.FSWatcher | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let changeTimer: ReturnType<typeof setTimeout> | null = null;
      let abortHandler: (() => void) | null = null;
      let signature = readSignature(filePath);

      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        if (changeTimer !== null) clearTimeout(changeTimer);
        heartbeat = null;
        changeTimer = null;
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      closeStream = cleanup;

      const send = (eventName: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(
            `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`,
          ));
        } catch {
          cleanup(false);
        }
      };

      const publishChange = () => {
        if (closed) return;
        const next = readSignature(filePath);
        if (!signatureChanged(signature, next)) return;
        signature = next;
        send("session_changed", {
          sessionId,
          exists: next.exists,
          mtime: next.exists ? new Date(next.mtimeMs).toISOString() : new Date().toISOString(),
          size: next.size,
        });
      };

      const scheduleChange = () => {
        if (closed || changeTimer !== null) return;
        changeTimer = setTimeout(() => {
          changeTimer = null;
          publishChange();
        }, CHANGE_DEBOUNCE_MS);
      };

      if (req.signal.aborted) {
        cleanup(true);
        return;
      }

      try {
        watcher = fs.watch(watchedDirectory, (_eventType, changedName) => {
          if (
            changedName != null
            && !samePath(path.join(watchedDirectory, changedName.toString()), filePath)
          ) return;
          scheduleChange();
        });
        watcher.on("error", () => cleanup(true));
        abortHandler = () => cleanup(true);
        req.signal.addEventListener("abort", abortHandler, { once: true });
        heartbeat = setInterval(() => {
          if (!closed) {
            try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(false); }
          }
        }, HEARTBEAT_INTERVAL_MS);

        // The client starts relying on this stream only after the watcher is
        // installed, so a write cannot be missed between connection and setup.
        send("connected", { sessionId });
        // Catch a write that landed between the initial stat and watcher setup.
        scheduleChange();
      } catch {
        send("watch_error", { sessionId, message: "Failed to watch session file" });
        cleanup(true);
      }
    },
    cancel() {
      closeStream(false);
    },
  });
}
