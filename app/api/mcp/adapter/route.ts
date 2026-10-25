import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { McpAdapterError, changeAdapterServer, readAdapterOverview, type McpAdapterProject } from "@/lib/mcp-adapter-config";
import type { McpAdapterAction, McpAdapterErrorResponse, McpAdapterOverview, McpAdapterRefusalReason } from "@/lib/mcp-adapter-types";
import { isMcpEntryRefusal, mcpProjectTrustRefusal, validateMcpProject } from "@/lib/mcp-entry-request";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › MCP › Adapter (docs/agents/mcp-adapter.md). GET reads
// pi-mcp-adapter's files and the live status sessions reported; nothing is
// connected or run. POST enables, disables or removes one server in those
// files; a project's files are written only while a decision trusts the folder.

function refusal(status: number, reason: McpAdapterRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpAdapterErrorResponse, { status });
}

async function project(value: unknown): Promise<McpAdapterProject | undefined | Response> {
  if (value === undefined || value === null) return undefined;
  const result = await validateMcpProject(value);
  if (isMcpEntryRefusal(result)) return refusal(result.status, result.body.reason as McpAdapterRefusalReason, result.body.error);
  return result;
}

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  const resolved = await project(cwd);
  if (resolved instanceof Response) return resolved;
  try {
    return NextResponse.json(readAdapterOverview({ agentDir: getAgentDir(), project: resolved }) satisfies McpAdapterOverview);
  } catch (error) {
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}

const ACTIONS: readonly McpAdapterAction[] = ["enable", "disable", "remove"];

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refusal(400, "invalid-request", "Expected a JSON object");
  const { action, name, scope, cwd } = body as { action?: unknown; name?: unknown; scope?: unknown; cwd?: unknown };
  if (typeof action !== "string" || !ACTIONS.includes(action as McpAdapterAction) || typeof name !== "string" || (scope !== "global" && scope !== "project")) {
    return refusal(400, "invalid-request", "Expected { action, name, scope }");
  }
  const resolved = await project(cwd);
  if (resolved instanceof Response) return resolved;
  const agentDir = getAgentDir();
  if (scope === "project") {
    if (!resolved) return refusal(400, "invalid-request", "A project server needs the project's cwd");
    const refused = mcpProjectTrustRefusal(resolved.cwd, agentDir, "The project is not trusted, so its adapter files are not changed");
    if (refused) return refusal(refused.status, refused.body.reason as McpAdapterRefusalReason, refused.body.error);
  }
  try {
    // A global change never sees project files: those need the trust check above.
    await changeAdapterServer({ agentDir, project: scope === "project" ? resolved : undefined, action: action as McpAdapterAction, name });
    return NextResponse.json(readAdapterOverview({ agentDir, project: resolved }) satisfies McpAdapterOverview);
  } catch (error) {
    if (error instanceof McpAdapterError) return refusal(error.status, error.reason, error.message);
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}
