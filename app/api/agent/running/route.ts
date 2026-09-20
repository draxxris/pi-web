import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getUnmanagedSubagentSessionIds } from "@/lib/subagent-session-lifecycle";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      // Live nested runs whose session handle Pi Web could not adopt. These are
      // included in runningSessionIds for sidebar activity, but the client must
      // watch their JSONL files instead of opening a second AgentSession.
      externalRunningSessionIds: getUnmanagedSubagentSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
