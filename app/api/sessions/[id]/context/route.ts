import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext, hasJ0k3rMarker } from "@/lib/session-reader";
import { getLiveSubagentSessionIds } from "@/lib/subagent-session-lifecycle";
import { getRpcSession } from "@/lib/rpc-manager";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    // Same stale-shadow guard as GET /api/sessions/[id]: j0k3r nested runs
    // append directly to the JSONL file, so pages for those files must be
    // sliced from disk, not from a wrapper opened before the run.
    const wrapperEntries = liveRpc
      ? (liveRpc.inner.sessionManager.getEntries() as unknown as SessionEntry[])
      : null;
    const readFromDisk = getLiveSubagentSessionIds().includes(id)
      || (wrapperEntries !== null && hasJ0k3rMarker(wrapperEntries));
    let filePath: string | null;
    if (readFromDisk) {
      filePath = liveRpc?.sessionFile || await resolveSessionPath(id);
    } else {
      filePath = liveRpc ? null : await resolveSessionPath(id);
    }
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = readFromDisk
      ? SessionManager.open(filePath!)
      : (liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!));
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      sessionId: id,
    });

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
