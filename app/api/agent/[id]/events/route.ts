import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getUnmanagedSubagentSessionIds } from "@/lib/subagent-session-lifecycle";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Nested runs owned by pi-subagents-j0k3r never emit through a pi-web
  // wrapper: their turns run inside the parent's process. When the host
  // published the live session handle, startRpcSession() adopts that object so
  // steer/follow-up/prompt reach the running subagent. Only runs whose handle
  // is unavailable stay file-watched, because a wrapper would be a stale
  // shadow while the host keeps writing.
  if (getUnmanagedSubagentSessionIds().includes(id)) {
    return new Response(
      "Session is running under an external subagent host; watch its session file instead",
      { status: 409 },
    );
  }

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
