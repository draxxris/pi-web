import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  attachSessionProjectInfo,
  cacheSessionPath,
  catalogFirstMessage,
  resolveSessionPath,
} from "@/lib/session-reader";
import { listLandstripAgents, type LandstripAgentTask } from "@/lib/landstrip-subagents";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function toSessionInfo(rootSessionId: string, { record, status, info }: LandstripAgentTask): SessionInfo {
  // The child resolves for the chat, a tab and the stats route without another
  // three-level walk of pi-landstrip's folders.
  cacheSessionPath(info.id, info.path);
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: catalogFirstMessage(info.firstMessage || "(no messages)"),
    // Every row hangs off the session this list was asked for, so the family
    // resolves even for a run a landstrip child nested under itself.
    relation: {
      kind: "subagent",
      parentSessionId: rootSessionId,
      profile: record.agent,
      description: record.description,
      status,
    },
    transient: false,
  };
}

// GET /api/sessions/[id]/landstrip - the pi-landstrip runs this session started,
// as the Agents switcher's subagent rows (read from the parent's `landstrip.task`
// entries and each run's own child session file). pi-landstrip runs them in
// another pi process, so nothing here starts an AgentSession or a wrapper: the
// rows only describe files that already exist.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const wrapper = getRpcSession(id);
    const live = wrapper?.isAlive() ? wrapper : undefined;
    // Whichever pi process drives the session appends its `landstrip.task`
    // records to the file, so the file is the complete source; an in-memory
    // wrapper only reflects the appends pi-web itself made. Its entries serve
    // the one case the file cannot: a wrapper whose file is not written yet.
    const sessionFile = (live?.sessionFile
      || live?.inner.sessionManager.getSessionFile()
      || await resolveSessionPath(id)) || undefined;
    const entries = sessionFile && existsSync(sessionFile) ? undefined : live?.inner.sessionManager.getEntries();
    const agents = await listLandstripAgents({ sessionId: id, sessionFile, entries });
    return NextResponse.json(
      { agents: await attachSessionProjectInfo(agents.map((agent) => toSessionInfo(id, agent))) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE });
  }
}
