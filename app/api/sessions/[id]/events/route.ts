import { createSessionFileEventStream } from "@/lib/session-file-events";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/sessions/[id]/events - read-only change notifications for persisted sessions
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const filePath = await resolveSessionPath(id);
  if (!filePath) return new Response("Session not found", { status: 404 });
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const stream = createSessionFileEventStream(req, id, filePath);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
