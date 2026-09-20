import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  getJ0k3rMarkerData,
  hasJ0k3rMarker,
  listAllSessions,
  readJ0k3rRun,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  isSubagentSessionFile,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { buildSessionDeletionPlan, type SessionDeletionRecord } from "@/lib/session-deletion";
import { stopRegisteredSubagentSessions } from "@/lib/subagent-session-lifecycle";
import { getLiveSubagentSessionIds } from "@/lib/subagent-session-lifecycle";
import { abortSubagent, getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    // j0k3r nested runs write straight to the JSONL file, bypassing any pi-web
    // wrapper for the same file. A wrapper opened before the run keeps serving
    // its stale in-memory entries, so reads for those files must come from disk.
    // The marker is written at session creation, so the wrapper's own entries
    // reliably identify ownership without extra I/O.
    const wrapperEntries = liveRpc
      ? (liveRpc.inner.sessionManager.getEntries() as unknown as SessionEntry[])
      : null;
    const liveExternalIds = new Set(getLiveSubagentSessionIds());
    const readFromDisk = liveExternalIds.has(id)
      || (wrapperEntries !== null && hasJ0k3rMarker(wrapperEntries));
    let sm: SessionManager;
    let filePath: string;
    if (readFromDisk) {
      const diskPath = liveRpc?.sessionFile || await resolveSessionPath(id);
      if (!diskPath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      sm = SessionManager.open(diskPath);
      filePath = sm.getSessionFile() || diskPath;
    } else {
      const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
      if (!liveRpc && !resolvedPath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
      filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    }
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    // j0k3r marker sessions are nested runs owned by another host, not forks.
    // readJ0k3rRun is display metadata only and never applies pi-web subagent
    // tool/status schemas to them (see lib/subagents.ts).
    let j0k3r: ReturnType<typeof readJ0k3rRun> = null;
    if (!subagent && header && getJ0k3rMarkerData(entries as never)) {
      const markerData = getJ0k3rMarkerData(entries as never);
      const markerParentPath = markerData && typeof markerData.parentSessionPath === "string"
        ? markerData.parentSessionPath
        : undefined;
      const markerParentId = markerParentPath
        ? await resolveSessionIdByPath(markerParentPath)
        : undefined;
      j0k3r = readJ0k3rRun(
        entries as never,
        header.id,
        filePath,
        parentSessionId,
        markerParentId,
        liveExternalIds.has(header.id),
      );
    }
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : j0k3r
          ? { relation: { kind: "subagent" as const, parentSessionId: j0k3r.parentSessionId, profile: j0k3r.profile, description: j0k3r.description, status: j0k3r.status } }
          : header.parentSession
            ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
            : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting. Empty runtime sessions
    // have a cached path before their first disk write (upstream edf0deb).
    let targetHeader: ReturnType<typeof readSessionHeader> | undefined;
    try {
      targetHeader = readSessionHeader(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targetHeader = undefined;
    }
    const listedSessions = await SessionManager.listAll();
    // Both standard pi-web subagents (pi-web:subagent, upstream e83f4b5) and
    // marked j0k3r sessions cascade-delete with their parent; ordinary forks
    // are preserved and reparented. listAllSessions synthesizes
    // relation.kind === "subagent" for both kinds (plus live RPC wrappers).
    const persistedRelations = await listAllSessions({ force: true });
    const subagentIds = new Set<string>();
    for (const session of persistedRelations) {
      if (session.relation?.kind === "subagent") subagentIds.add(session.id);
    }
    for (const live of getRpcSessionInfos({ includeTransient: true })) {
      if (live.relation?.kind === "subagent") subagentIds.add(live.id);
    }
    const records: SessionDeletionRecord[] = listedSessions.map((session) => ({
      id: session.id,
      path: session.path,
      parentPath: session.parentSessionPath,
      isSubagent: isSubagentSessionFile(session.path) || subagentIds.has(session.id),
    }));
    // Include local files even when the global catalogue is stale or incomplete
    // (upstream e83f4b5): the DELETE integration test uses an isolated tmpdir
    // outside the session directories, so catalogue-only records would miss
    // the siblings entirely and leave subagent descendants behind.
    try {
      const dir = dirname(filePath);
      const seenKeys = new Set(records.map((record) => sessionPathKey(record.path)));
      seenKeys.add(sessionPathKey(filePath));
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
        const childPath = join(dir, file);
        if (seenKeys.has(sessionPathKey(childPath))) continue;
        try {
          const lines = readFileSync(childPath, "utf8").split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
          if (header.type !== "session" || typeof header.id !== "string") continue;
          const entries = lines.slice(1).flatMap((line) => {
            try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
          });
          const isStandardSubagent = !!readSubagentRun(entries, header.id, childPath);
          seenKeys.add(sessionPathKey(childPath));
          records.push({
            id: header.id,
            path: childPath,
            parentPath: header.parentSession,
            isSubagent: isStandardSubagent || isSubagentSessionFile(childPath) || subagentIds.has(header.id),
          });
        } catch { /* skip malformed or concurrently removed sessions */ }
      }
    } catch { /* skip if dir unreadable */ }
    const plan = buildSessionDeletionPlan(records, filePath, id, targetHeader?.parentSession);
    const deletedPaths = plan.deleteRecords.map((record) => record.path);

    // Stop both Pi Web-owned wrappers and externally owned j0k3r sessions
    // before deleting their files. Normal fork sessions are not in the
    // deletion set and remain untouched.
    await getRpcSession(id)?.shutdown();
    await Promise.all(
      plan.deleteRecords
        .filter((record) => record.id && record.id !== id)
        .map((record) => getRpcSession(record.id)?.shutdown()),
    );
    for (const record of plan.deleteRecords) {
      if (!record.id || record.id === id) continue;
      try { await abortSubagent(record.id); } catch { /* idle or completed */ }
    }
    try { await abortSubagent(id); } catch { /* ordinary session */ }
    // Transient live subagents without persisted files (upstream e83f4b5).
    try {
      const deletedIds = new Set<string>([id]);
      for (const record of plan.deleteRecords) {
        if (record.id) deletedIds.add(record.id);
      }
      const liveInfos = getRpcSessionInfos({ includeTransient: true });
      let grew = true;
      while (grew) {
        grew = false;
        for (const live of liveInfos) {
          if (!live.id || deletedIds.has(live.id) || live.relation?.kind !== "subagent") continue;
          if (deletedIds.has(live.relation.parentSessionId)) {
            deletedIds.add(live.id);
            grew = true;
          }
        }
      }
      for (const deadId of deletedIds) {
        if (deadId === id || plan.deleteRecords.some((record) => record.id === deadId)) continue;
        try { await abortSubagent(deadId); } catch { /* idle or completed */ }
        await getRpcSession(deadId)?.shutdown();
      }
    } catch { /* best-effort live teardown */ }
    await stopRegisteredSubagentSessions(deletedPaths, "Parent Pi session deleted");

    for (const operation of plan.reparent) {
      try {
        const content = readFileSync(operation.path, "utf8");
        const newlineIndex = content.indexOf("\n");
        const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
        const suffix = newlineIndex === -1 ? "\n" : content.slice(newlineIndex);
        const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
        if (header.type !== "session") continue;
        if (operation.parentPath) header.parentSession = operation.parentPath;
        else delete header.parentSession;
        if (operation.parentPath) {
          // The parent may have been deleted or moved already; treat it as absent (upstream 9cf8d4d).
          let parentSessionId: string | undefined;
          try {
            parentSessionId = readSessionHeader(operation.parentPath)?.id;
          } catch {
            parentSessionId = undefined;
          }
          if (parentSessionId) {
            const lines = suffix.split("\n");
            for (let index = 0; index < lines.length; index += 1) {
              let entry: { type?: string; customType?: string; data?: unknown };
              try {
                entry = JSON.parse(lines[index]);
              } catch {
                continue;
              }
              if (
                entry.type !== "custom"
                || entry.customType !== SUBAGENT_META_TYPE
                || typeof entry.data !== "object"
                || entry.data === null
                || Array.isArray(entry.data)
              ) continue;
              entry.data = {
                ...entry.data,
                parentSessionId,
                parentSessionPath: operation.parentPath,
              };
              lines[index] = JSON.stringify(entry);
              break;
            }
            writeFileSync(operation.path, JSON.stringify(header) + lines.join("\n"));
            continue;
          }
        }
        writeFileSync(operation.path, JSON.stringify(header) + suffix);
      } catch { /* skip malformed or vanished sessions */ }
    }

    for (const record of plan.deleteRecords) {
      try {
        if (existsSync(record.path)) unlinkSync(record.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (record.id) invalidateSessionPathCache(record.id);
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
