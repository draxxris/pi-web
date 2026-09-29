import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageId } from "./provider-usage-ids";

export { PROVIDER_USAGE_IDS, isProviderUsageId, type ProviderUsageId } from "./provider-usage-ids";

// Query formats follow @narumitw/pi-usage (MIT, Copyright (c) 2026 narumiruna),
// but this module deliberately has no runtime dependency on that extension.

export type UsageUnit = "percent" | "currency" | "count";

export interface UsageBucket {
  id: string;
  label: string;
  groupLabel?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnit;
  currency?: string;
  windowMinutes?: number;
  resetsAt?: number;
  period?: string;
}

export interface UsageMetric {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnit;
  currency?: string;
}

export interface UsageReport {
  providerId: ProviderUsageId;
  providerName: string;
  capturedAt: number;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  notes?: string[];
}

export type ProviderUsageResult =
  | { providerId: ProviderUsageId; status: "ready"; report: UsageReport }
  | { providerId: ProviderUsageId; status: "auth-unavailable" | "query-failed"; message: string };

const ENDPOINTS: Partial<Record<ProviderUsageId, string>> = {
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
  openrouter: "https://openrouter.ai/api/v1/key",
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  "moonshotai-cn": "https://api.moonshot.cn/v1/users/me/balance",
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/credits",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
  "kimi-coding": "https://api.kimi.com/coding/v1/usages",
  commandcode: "https://api.commandcode.ai/alpha/whoami",
};

const OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";
const CLI_TIMEOUT_MS = 45_000;
const CLI_MAX_BUFFER = 256 * 1024;
const ANTHROPIC_OAUTH_TOKEN_MARKER = "sk-ant-oat";
const execFileAsync = promisify(execFile);

const PROVIDER_NAMES: Record<ProviderUsageId, string> = {
  anthropic: "Claude",
  antigravity: "Antigravity",
  "openai-codex": "OpenAI Codex",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi For Coding",
  commandcode: "Command Code",
};

const CURRENCY: Record<"moonshotai" | "moonshotai-cn" | "minimax" | "minimax-cn", string> = {
  moonshotai: "USD",
  "moonshotai-cn": "CNY",
  minimax: "USD",
  "minimax-cn": "CNY",
};

export function getProviderUsageVisibility(env: NodeJS.ProcessEnv = process.env): Partial<Record<ProviderUsageId, boolean>> {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    "opencode-go": Boolean(env.OPENCODE_API_KEY),
    commandcode: Boolean(env.COMMAND_CODE_API_KEY),
  };
}

/** Visibility plus the providers shown only while Pi holds a usable credential for them. */
export async function getProviderUsageVisibilityWithAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Partial<Record<ProviderUsageId, boolean>>> {
  const visibility = getProviderUsageVisibility(env);
  // Antigravity reads its quota from the agy CLI, so it stays listed.
  visibility.anthropic = Boolean(readAnthropicOAuthToken());
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    visibility["openai-codex"] = Boolean(await resolveRuntimeAuth(runtime, "openai-codex"));
  } catch {
    visibility["openai-codex"] = false;
  }
  return visibility;
}

export async function queryProviderUsage(providerId: ProviderUsageId): Promise<ProviderUsageResult> {
  if (providerId === "antigravity") return queryAntigravityUsage();
  if (providerId === "anthropic") return queryAnthropicUsage();
  if (providerId === "commandcode") return queryCommandCodeUsage();

  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  return queryRuntimeProviderUsage(providerId, runtime);
}

async function queryRuntimeProviderUsage(
  providerId: ProviderUsageId,
  runtime: ModelRuntime,
): Promise<ProviderUsageResult> {
  const provider = runtime.getProvider(providerId);
  // Catalog providers such as opencode-go carry their base URL per model rather than on the
  // provider, so fall back to the first model before rejecting a non-official origin.
  if (!provider) {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
  const baseUrl = provider.baseUrl ?? provider.getModels()[0]?.baseUrl;
  if (!isOfficialProviderUsageOrigin(providerId, baseUrl)) {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
  const resolved = await resolveRuntimeAuth(runtime, providerId);
  if (!resolved) {
    return { providerId, status: "auth-unavailable", message: "Connect this provider before querying usage." };
  }
  return queryRuntimeUsage(providerId, resolved.auth);
}

async function resolveRuntimeAuth(runtime: ModelRuntime, providerId: ProviderUsageId) {
  try {
    return await runtime.getAuth(providerId);
  } catch {
    return undefined;
  }
}

async function queryRuntimeUsage(
  providerId: ProviderUsageId,
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string },
): Promise<ProviderUsageResult> {
  try {
    const payload = providerId === "openrouter" ? await fetchOpenRouterPayload(auth) : await fetchJson(providerId, auth);
    const capturedAt = Date.now();
    return {
      providerId,
      status: "ready",
      report: normalize(providerId, payload, capturedAt),
    };
  } catch {
    return { providerId, status: "query-failed", message: "The provider usage query failed." };
  }
}

async function queryAnthropicUsage(): Promise<ProviderUsageResult> {
  const accessToken = readAnthropicOAuthToken();
  if (!accessToken) {
    return {
      providerId: "anthropic",
      status: "auth-unavailable",
      message: "Pi has no valid Anthropic OAuth token stored. Refresh Anthropic auth in Pi, then retry.",
    };
  }
  try {
    const payload = await fetchJson("anthropic", { apiKey: accessToken }, undefined, {
      "anthropic-beta": "oauth-2025-04-20",
    });
    return {
      providerId: "anthropic",
      status: "ready",
      report: normalize("anthropic", payload, Date.now()),
    };
  } catch {
    return { providerId: "anthropic", status: "query-failed", message: "The provider usage query failed." };
  }
}

function readAnthropicOAuthToken(): string | undefined {
  try {
    // pi-anthropic-auth delegates token ownership and refresh to Pi; its
    // extension context is not available in this route. Read Pi's stored
    // credential directly and leave refresh to Pi rather than ModelRuntime.
    const credential = readStoredCredential("anthropic");
    if (credential?.type !== "oauth" || !credential.access.includes(ANTHROPIC_OAUTH_TOKEN_MARKER)) return undefined;
    return credential.expires > Date.now() + 60_000 ? credential.access : undefined;
  } catch {
    return undefined;
  }
}

async function queryAntigravityUsage(): Promise<ProviderUsageResult> {
  try {
    const { stdout } = await runAntigravityCli();
    const result = record(JSON.parse(stdout));
    if (!result || result.status !== "SUCCESS" || cliStartedModelTurn(result) || typeof result.response !== "string") {
      throw new Error("Antigravity CLI returned no quota report.");
    }
    return {
      providerId: "antigravity",
      status: "ready",
      report: normalize("antigravity", { cliResponse: result.response }, Date.now()),
    };
  } catch {
    return { providerId: "antigravity", status: "query-failed", message: "The provider usage query failed." };
  }
}

async function runAntigravityCli(): Promise<{ stdout: string }> {
  return execFileAsync("agy", ["--prompt", "/quota", "--output-format", "json"], {
    cwd: tmpdir(),
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
    // Both commands and every argument are fixed constants; shell mode is only
    // needed on Windows to launch provider .cmd shims from PATH.
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function cliStartedModelTurn(result: Record<string, unknown>): boolean {
  return (number(result.num_turns) ?? 0) > 0;
}

async function fetchOpenRouterPayload(auth: {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}): Promise<Record<string, unknown>> {
  const [keyPayload, creditsPayload] = await Promise.all([
    fetchOptionalJson("openrouter", auth),
    fetchOptionalJson("openrouter", auth, OPENROUTER_CREDITS_ENDPOINT),
  ]);
  if (!keyPayload && !creditsPayload) throw new Error("OpenRouter usage endpoints failed.");
  const keyData = record(keyPayload?.data);
  const creditsData = record(creditsPayload?.data);
  return {
    ...(keyData ? { data: keyData } : {}),
    ...(creditsData ? { credits: creditsData } : {}),
    ...(!creditsPayload ? { notes: ["OpenRouter balance could not be read."] } : {}),
  };
}

async function fetchOptionalJson(
  providerId: ProviderUsageId,
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string },
  endpoint?: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await fetchJson(providerId, auth, endpoint);
  } catch {
    return undefined;
  }
}

async function fetchJson(providerId: ProviderUsageId, auth: {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}, endpointOverride?: string, extraHeaders?: Record<string, string>): Promise<Record<string, unknown>> {
  const endpoint = getOfficialUsageEndpoint(providerId, auth.baseUrl, endpointOverride);
  const headers = createUsageHeaders(auth, extraHeaders);
  const requestEndpoint = appendMiniMaxEndpoint(providerId, endpoint, headers, auth.apiKey);
  const response = await fetch(requestEndpoint, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return parseUsageResponse(response);
}

function getOfficialUsageEndpoint(providerId: ProviderUsageId, authBaseUrl?: string, override?: string): string {
  const officialEndpoint = ENDPOINTS[providerId];
  if (!officialEndpoint) throw new Error("This provider has no official usage endpoint.");
  if (authBaseUrl && !isOfficialProviderUsageOrigin(providerId, authBaseUrl)) {
    throw new Error("A custom provider origin cannot be used for official usage queries.");
  }
  const endpoint = override ?? officialEndpoint;
  if (!isOfficialProviderUsageOrigin(providerId, endpoint)) {
    throw new Error("A non-official usage endpoint cannot be used.");
  }
  return endpoint;
}

function createUsageHeaders(
  auth: { apiKey?: string; headers?: Record<string, string | null> },
  extraHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  if (!headers.has("authorization") && auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
  return headers;
}

function appendMiniMaxEndpoint(
  providerId: ProviderUsageId,
  endpoint: string,
  headers: Headers,
  apiKey?: string,
): string {
  if (providerId === "minimax" || providerId === "minimax-cn") {
    const token = bearerToken(headers.get("authorization")) ?? apiKey;
    endpoint += token?.startsWith("sk-api-") ? "/account/query_balance" : "/v1/token_plan/remains";
  }
  return endpoint;
}

async function parseUsageResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > 65_536) throw new Error("Usage response was too large.");
  if (!response.ok) throw new Error(`Usage endpoint returned ${response.status}.`);
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("Usage response was not an object.");
  return parsed;
}

export function isOfficialProviderUsageOrigin(providerId: ProviderUsageId, baseUrl: string | undefined): boolean {
  const endpoint = ENDPOINTS[providerId];
  if (!baseUrl || !endpoint) return false;
  try {
    return new URL(baseUrl).origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}

type ProviderUsageNormalizer = (
  providerId: ProviderUsageId,
  payload: Record<string, unknown>,
  capturedAt: number,
) => UsageReport;

const NORMALIZERS: Record<ProviderUsageId, ProviderUsageNormalizer> = {
  anthropic: (_id, payload, capturedAt) => normalizeAnthropic(payload, capturedAt),
  antigravity: (_id, payload, capturedAt) => normalizeAntigravity(payload, capturedAt),
  "openai-codex": (_id, payload, capturedAt) => normalizeCodex(payload, capturedAt),
  deepseek: (_id, payload, capturedAt) => normalizeDeepSeek(payload, capturedAt),
  openrouter: (_id, payload, capturedAt) => normalizeOpenRouter(payload, capturedAt),
  moonshotai: (_id, payload, capturedAt) => normalizeMoonshot("moonshotai", payload, capturedAt),
  "moonshotai-cn": (_id, payload, capturedAt) => normalizeMoonshot("moonshotai-cn", payload, capturedAt),
  minimax: (_id, payload, capturedAt) => normalizeMiniMax("minimax", payload, capturedAt),
  "minimax-cn": (_id, payload, capturedAt) => normalizeMiniMax("minimax-cn", payload, capturedAt),
  "vercel-ai-gateway": (_id, payload, capturedAt) => normalizeVercel(payload, capturedAt),
  "opencode-go": (_id, payload, capturedAt) => normalizeOpenCodeGo(payload, capturedAt),
  "kimi-coding": (_id, payload, capturedAt) => normalizeKimiCoding(payload, capturedAt),
  commandcode: (_id, payload, capturedAt) => normalizeCommandCode(payload, capturedAt),
};

function normalize(providerId: ProviderUsageId, payload: Record<string, unknown>, capturedAt: number): UsageReport {
  return NORMALIZERS[providerId](providerId, payload, capturedAt);
}

async function queryCommandCodeUsage(): Promise<ProviderUsageResult> {
  const apiKey = process.env.COMMAND_CODE_API_KEY;
  if (!apiKey) return { providerId: "commandcode", status: "auth-unavailable", message: "Set COMMAND_CODE_API_KEY to query Command Code usage." };
  try {
    const report = await fetchCommandCodeReport(apiKey);
    return { providerId: "commandcode", status: "ready", report };
  } catch {
    return { providerId: "commandcode", status: "query-failed", message: "The Command Code quota query failed." };
  }
}

async function fetchCommandCodeReport(apiKey: string): Promise<UsageReport> {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const account = parseCommandCodeAccount(await fetchCommandCodeJson("/alpha/whoami", headers));
  if (!account) throw new Error("Unrecognized account response");
  const orgId = stringValue(account.orgId);
  const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const [credits, subscription] = await Promise.all([
    fetchCommandCodeJson(`/alpha/billing/credits${orgQuery}`, headers),
    fetchCommandCodeJson(`/alpha/billing/subscriptions${orgQuery}`, headers),
  ]);
  const summary = await fetchCommandCodeSummary(headers, orgId, subscription);
  return normalize("commandcode", { account, credits, subscription, summary }, Date.now());
}

async function fetchCommandCodeSummary(
  headers: Record<string, string>,
  orgId: string | undefined,
  subscription: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = record(subscription.data);
  const periodStart = stringOrNumber(data?.currentPeriodStart);
  const query = new URLSearchParams();
  if (orgId) query.set("orgId", orgId);
  if (periodStart) query.set("since", periodStart);
  return fetchCommandCodeJson(`/alpha/usage/summary${query.size ? `?${query}` : ""}`, headers);
}
async function fetchCommandCodeJson(path: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.commandcode.ai${path}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return parseUsageResponse(response);
}

function parseCommandCodeAccount(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const org = record(payload.org);
  const user = record(payload.user);
  const login = firstString(org?.login, user?.userName, user?.name);
  if (!login) return undefined;
  return { login, orgId: stringValue(org?.id), keyName: firstString(user?.keyName, user?.displayName) };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return undefined;
}

function stringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
export function normalizeProviderUsagePayload(
  providerId: ProviderUsageId,
  payload: Record<string, unknown>,
  capturedAt = Date.now(),
): UsageReport {
  return normalize(providerId, payload, capturedAt);
}

function normalizeCodex(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const buckets: UsageBucket[] = [];
  const addGroup = (group: Record<string, unknown>, groupLabel: string, groupId: string) => {
    for (const [position, raw] of [["primary", group.primary_window], ["secondary", group.secondary_window]] as const) {
      const window = record(raw);
      const used = number(window?.used_percent);
      if (used === undefined) continue;
      const seconds = number(window?.limit_window_seconds);
      buckets.push({
        id: `${groupId}:${position}`,
        label: windowLabel(seconds),
        ...(groupId === "codex" ? {} : { groupLabel }),
        used: clamp(used),
        remaining: 100 - clamp(used),
        limit: 100,
        unit: "percent",
        ...(seconds && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
        ...(number(window?.reset_at) !== undefined ? { resetsAt: number(window?.reset_at) } : {}),
      });
    }
  };
  const rateLimit = record(payload.rate_limit);
  if (rateLimit) addGroup(rateLimit, "Codex", "codex");
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  additional.forEach((item, index) => {
    const value = record(item);
    const rate = record(value?.rate_limit);
    if (rate) addGroup(rate, stringValue(value?.limit_name) ?? `Limit ${index + 1}`, stringValue(value?.metered_feature) ?? `additional-${index}`);
  });
  const metrics: UsageMetric[] = [];
  if (!buckets.length && !metrics.length) throw new Error("Codex returned no usage data.");
  return { providerId: "openai-codex", providerName: PROVIDER_NAMES["openai-codex"], capturedAt, buckets, metrics };
}

function normalizeAnthropic(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const buckets = normalizeAnthropicLimits(payload.limits);
  if (buckets.length === 0) buckets.push(...normalizeAnthropicLegacyWindows(payload));
  if (!buckets.length) throw new Error("Claude returned no usage data.");
  return { providerId: "anthropic", providerName: PROVIDER_NAMES.anthropic, capturedAt, buckets, metrics: [] };
}

function normalizeAnthropicLimits(input: unknown): UsageBucket[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value, index) => {
    const limit = record(value);
    const utilization = number(limit?.percent);
    if (!limit || utilization === undefined) return [];

    const kind = stringValue(limit.kind);
    const group = stringValue(limit.group);
    const model = anthropicLimitModel(limit.scope);
    const windowMinutes = anthropicWindowMinutes(kind, group);
    const resetsAt = epochSeconds(limit.resets_at);
    return [{
      id: `limit-${index}`,
      label: anthropicLimitLabel(kind, group, model, index),
      used: clamp(utilization),
      remaining: 100 - clamp(utilization),
      limit: 100,
      unit: "percent" as const,
      ...(windowMinutes ? { windowMinutes } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    }];
  });
}

function normalizeAnthropicLegacyWindows(payload: Record<string, unknown>): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const windows = [
    ["five_hour", "session", "Session (5h)", 300],
    ["seven_day", "weekly", "Weekly", 10_080],
    ["seven_day_sonnet", "weekly-sonnet", "Sonnet weekly", 10_080],
    ["seven_day_opus", "weekly-opus", "Opus weekly", 10_080],
    ["seven_day_oauth_apps", "weekly-oauth-apps", "OAuth apps weekly", 10_080],
  ] as const;
  for (const [field, id, label, windowMinutes] of windows) {
    const window = record(payload[field]);
    const utilization = number(window?.utilization);
    if (utilization === undefined) continue;
    buckets.push({
      id,
      label,
      used: clamp(utilization),
      remaining: 100 - clamp(utilization),
      limit: 100,
      unit: "percent",
      windowMinutes,
      ...(epochSeconds(window?.resets_at) !== undefined ? { resetsAt: epochSeconds(window?.resets_at) } : {}),
    });
  }
  return buckets;
}

function anthropicLimitModel(scope: unknown): string | undefined {
  const value = record(scope);
  const model = record(value?.model);
  return stringValue(model?.display_name) ?? stringValue(model?.id);
}

const ANTHROPIC_LIMIT_LABELS = new Map([
  ["session", "Session (5h)"],
  ["weekly_all", "Weekly"],
]);

function anthropicLimitLabel(
  kind: string | undefined,
  group: string | undefined,
  model: string | undefined,
  index: number,
): string {
  if (kind === "weekly_scoped" && model) return anthropicScopedLimitLabel(model);
  const knownLabel = kind ? ANTHROPIC_LIMIT_LABELS.get(kind) : undefined;
  if (knownLabel) return knownLabel;
  if (group === "session") return "Session (5h)";
  if (group === "weekly") return "Weekly";
  return kind ?? `Quota ${index + 1}`;
}

function anthropicScopedLimitLabel(model: string): string {
  if (/sonnet/iu.test(model)) return "Sonnet weekly";
  if (/opus/iu.test(model)) return "Opus weekly";
  return `${model} weekly`;
}

function anthropicWindowMinutes(kind?: string, group?: string): number | undefined {
  if (kind === "session" || group === "session") return 300;
  if (kind?.startsWith("weekly_") || group === "weekly") return 10_080;
  return undefined;
}

function normalizeAntigravity(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const response = typeof payload.cliResponse === "string" ? payload.cliResponse : "";
  const buckets = response.split(/\r?\n/u).flatMap(parseAntigravityCliLine);
  if (!buckets.length) throw new Error("Antigravity CLI returned no Gemini quota data.");
  return { providerId: "antigravity", providerName: PROVIDER_NAMES.antigravity, capturedAt, buckets, metrics: [] };
}

const ANTIGRAVITY_WINDOWS = {
  weekly: { id: "gemini-weekly", label: "Weekly", windowMinutes: 10_080 },
  "five-hour": { id: "gemini-session", label: "5h", windowMinutes: 300 },
} as const;

function parseAntigravityCliLine(line: string): UsageBucket[] {
  const argon = parseAntigravityArgonLine(line);
  if (argon) return [argon];
  const row = parseAntigravityCliRow(line);
  if (!row) return [];
  const window = antigravityQuotaWindow(row.label);
  if (!window) return [];
  const remaining = number(row.remaining.replace(/%$/u, ""));
  if (remaining === undefined) return [];
  return [createAntigravityQuotaBucket(ANTIGRAVITY_WINDOWS[window], row.reset, remaining)];
}

function createAntigravityQuotaBucket(
  window: (typeof ANTIGRAVITY_WINDOWS)[keyof typeof ANTIGRAVITY_WINDOWS],
  reset: string | undefined,
  remaining: number,
): UsageBucket {
  const resetsAt = reset ? epochSeconds(reset) : undefined;
  return {
    ...window,
    groupLabel: "Gemini",
    used: 100 - clamp(remaining),
    remaining: clamp(remaining),
    limit: 100,
    unit: "percent",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseAntigravityArgonLine(line: string): UsageBucket | undefined {
  const [group, label, remaining, reset] = line.split("\t").map((part) => part.trim());
  if (!group || !label || !remaining || !/argon/iu.test(group) || !/weekly/iu.test(label)) return undefined;
  const value = number(remaining.replace(/%$/u, ""));
  if (value === undefined) return undefined;
  const resetsAt = reset ? epochSeconds(reset) : undefined;
  return {
    id: "argon-weekly", label: "Weekly", windowMinutes: 10_080, groupLabel: "Argon",
    used: 100 - clamp(value), remaining: clamp(value), limit: 100, unit: "percent",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseAntigravityCliRow(line: string): { label: string; remaining: string; reset?: string } | undefined {
  const [group, label, remaining, reset] = line.split("\t").map((part) => part.trim());
  if (group !== "Gemini Models" || !label || !remaining) return undefined;
  return { label, remaining, ...(reset ? { reset } : {}) };
}

function antigravityQuotaWindow(label: string): "weekly" | "five-hour" | undefined {
  if (/weekly/iu.test(label)) return "weekly";
  if (/five\s+hour/iu.test(label)) return "five-hour";
  return undefined;
}

function normalizeDeepSeek(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const metrics: UsageMetric[] = [{ id: "availability", label: "API calls", value: payload.is_available === true ? "Available" : "Unavailable" }];
  const rows = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  for (const row of rows) {
    const value = record(row);
    const currency = value?.currency === "CNY" || value?.currency === "USD" ? value.currency : undefined;
    if (!currency) continue;
    for (const [id, label, field] of [["total", "Total balance", "total_balance"], ["granted", "Granted balance", "granted_balance"], ["topped-up", "Topped-up balance", "topped_up_balance"]] as const) {
      const amount = decimal(value?.[field]);
      if (amount !== undefined) metrics.push({ id: `${currency.toLowerCase()}-${id}`, label, value: amount, unit: "currency", currency });
    }
  }
  if (rows.length === 0) throw new Error("DeepSeek returned no balance data.");
  return { providerId: "deepseek", providerName: PROVIDER_NAMES.deepseek, capturedAt, buckets: [], metrics };
}

function normalizeOpenRouter(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const keyData = record(payload.data);
  const credits = record(payload.credits);
  assertOpenRouterPayload(keyData, credits);
  const balance = credits ? normalizeOpenRouterBalance(credits) : undefined;
  const keyUsage = keyData ? normalizeOpenRouterKeyUsage(keyData) : { buckets: [], metrics: [] };
  const buckets = keyUsage.buckets;
  const metrics = [...(balance ? [balance] : []), ...keyUsage.metrics];
  assertOpenRouterUsage(buckets, metrics);
  const notes = openRouterNotes(payload.notes, balance);
  return { providerId: "openrouter", providerName: PROVIDER_NAMES.openrouter, capturedAt, buckets, metrics, ...(notes.length ? { notes } : {}) };
}

function assertOpenRouterPayload(
  keyData: Record<string, unknown> | undefined,
  credits: Record<string, unknown> | undefined,
): void {
  if (!keyData && !credits) throw new Error("OpenRouter returned no usage data.");
}

function assertOpenRouterUsage(buckets: UsageBucket[], metrics: UsageMetric[]): void {
  if (!buckets.length && !metrics.length) throw new Error("OpenRouter returned no usage data.");
}

function openRouterNotes(rawNotes: unknown, balance?: UsageMetric): string[] {
  const notes = Array.isArray(rawNotes) ? rawNotes.filter((note): note is string => typeof note === "string") : [];
  if (!balance) notes.push("OpenRouter balance could not be read.");
  return notes;
}

function normalizeOpenRouterBalance(credits: Record<string, unknown>): UsageMetric | undefined {
  const total = nonnegative(credits.total_credits);
  const used = nonnegative(credits.total_usage);
  if (total === undefined || used === undefined) return undefined;
  return {
    id: "balance",
    label: "Balance remaining",
    value: Number(Math.max(0, total - used).toFixed(2)),
    unit: "currency",
    currency: "USD",
  };
}

function normalizeOpenRouterKeyUsage(data: Record<string, unknown>): { buckets: UsageBucket[]; metrics: UsageMetric[] } {
  const buckets: UsageBucket[] = [];
  const limit = nonnegative(data.limit);
  const remaining = nonnegative(data.limit_remaining);
  if (limit !== undefined) {
    buckets.push({
      id: "key-limit",
      label: "Key limit",
      limit,
      ...(remaining !== undefined ? { remaining, used: Math.max(0, limit - remaining) } : {}),
      unit: "currency",
      currency: "USD",
      ...(stringValue(data.limit_reset) ? { period: stringValue(data.limit_reset) } : {}),
    });
  }
  const metrics: UsageMetric[] = [];
  for (const [id, label, field] of [["daily", "Usage today", "usage_daily"], ["weekly", "Usage this week", "usage_weekly"], ["monthly", "Usage this month", "usage_monthly"], ["total", "All-time usage", "usage"]] as const) {
    const amount = nonnegative(data[field]);
    if (amount !== undefined) metrics.push({ id, label, value: amount, unit: "currency", currency: "USD" });
  }
  return { buckets, metrics };
}

function normalizeVercel(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const balance = decimal(payload.balance);
  const used = decimal(payload.total_used);
  if (balance === undefined && used === undefined) throw new Error("Vercel returned no credit data.");
  return {
    providerId: "vercel-ai-gateway",
    providerName: PROVIDER_NAMES["vercel-ai-gateway"],
    capturedAt,
    buckets: [],
    metrics: [
      ...(balance !== undefined ? [{ id: "balance", label: "Credit balance", value: balance, unit: "currency" as const, currency: "USD" }] : []),
      ...(used !== undefined ? [{ id: "spent", label: "Lifetime spend", value: used, unit: "currency" as const, currency: "USD" }] : []),
    ],
  };
}

function normalizeMoonshot(providerId: "moonshotai" | "moonshotai-cn", payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const data = record(payload.data);
  if (payload.code !== 0 || payload.status !== true || !data) throw new Error("Moonshot returned an unsuccessful response.");
  const metrics = [
    ["available", "Available balance", data.available_balance],
    ["voucher", "Voucher balance", data.voucher_balance],
    ["cash", "Cash balance", data.cash_balance],
  ].flatMap(([id, label, value]) => {
    const amount = number(value);
    return amount === undefined ? [] : [{ id: String(id), label: String(label), value: String(amount), unit: "currency" as const, currency: CURRENCY[providerId] }];
  });
  if (!metrics.length) throw new Error("Moonshot returned no balance data.");
  return { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets: [], metrics };
}

function normalizeMiniMax(providerId: "minimax" | "minimax-cn", payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const base = record(payload.base_resp);
  if (base && base.status_code !== 0) throw new Error("MiniMax returned an unsuccessful response.");
  if (Array.isArray(payload.model_remains)) {
    const buckets: UsageBucket[] = [];
    for (const [index, rowValue] of payload.model_remains.entries()) {
      const row = record(rowValue);
      if (!row) continue;
      const groupLabel = stringValue(row.model_name) ?? `Quota ${index + 1}`;
      addMiniMaxWindow(buckets, row, groupLabel, "interval", "current_interval_remaining_percent", "current_interval_usage_count", "current_interval_total_count", "end_time", "start_time");
      addMiniMaxWindow(buckets, row, groupLabel, "weekly", "current_weekly_remaining_percent", "current_weekly_usage_count", "current_weekly_total_count", "weekly_end_time", "weekly_start_time");
    }
    if (!buckets.length) throw new Error("MiniMax returned no quota data.");
    return { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets, metrics: [] };
  }
  const metrics = [
    ["available", "Available balance", payload.available_amount],
    ["cash", "Cash balance", payload.cash_balance],
    ["voucher", "Voucher balance", payload.voucher_balance],
    ["credit", "Credit balance", payload.credit_balance],
  ].flatMap(([id, label, value]) => {
    const amount = decimal(value);
    return amount === undefined ? [] : [{ id: String(id), label: String(label), value: amount, unit: "currency" as const, currency: CURRENCY[providerId] }];
  });
  if (!metrics.length) throw new Error("MiniMax returned no balance data.");
  return { providerId, providerName: PROVIDER_NAMES[providerId], capturedAt, buckets: [], metrics };
}

function addMiniMaxWindow(buckets: UsageBucket[], row: Record<string, unknown>, groupLabel: string, suffix: string, percentField: string, countField: string, totalField: string, endField: string, startField: string): void {
  const status = number(row[`${suffix === "interval" ? "current_interval" : "current_weekly"}_status`]);
  const end = number(row[endField]);
  const start = number(row[startField]);
  const percent = nonnegative(row[percentField]);
  if (status === 3) {
    buckets.push({ id: `${groupLabel}:${suffix}`, label: suffix === "weekly" ? "Weekly" : "Rolling", groupLabel, remaining: 100, unit: "percent", period: "Unlimited" });
    return;
  }
  const total = nonnegativeInteger(row[totalField]);
  const count = nonnegativeInteger(row[countField]);
  if (total === undefined && percent === undefined) return;
  const windowMinutes = end !== undefined && start !== undefined ? Math.max(1, Math.round((end - start) / 60_000)) : undefined;
  const resetsAt = end !== undefined ? Math.floor(end / 1_000) : undefined;
  if (total && count !== undefined) {
    let remaining = count;
    if (percent !== undefined) {
      const asRemaining = count / total * 100;
      const asUsed = (total - count) / total * 100;
      if (Math.abs(asUsed - percent) < Math.abs(asRemaining - percent)) remaining = total - count;
    }
    buckets.push({ id: `${groupLabel}:${suffix}`, label: suffix === "weekly" ? "Weekly" : "Rolling", groupLabel, used: total - remaining, remaining, limit: total, unit: "count", ...(windowMinutes ? { windowMinutes } : {}), ...(resetsAt ? { resetsAt } : {}) });
    return;
  }
  buckets.push({ id: `${groupLabel}:${suffix}`, label: suffix === "weekly" ? "Weekly" : "Rolling", groupLabel, used: 100 - clamp(percent!), remaining: clamp(percent!), limit: 100, unit: "percent", ...(windowMinutes ? { windowMinutes } : {}), ...(resetsAt ? { resetsAt } : {}) });
}

function normalizeCommandCode(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  const credits = record(payload.credits);
  const subscription = record(payload.subscription);
  const summary = record(payload.summary);
  const account = record(payload.account);
  const buckets = normalizeCommandCodeWindows(credits?.windowLimits);
  const metrics = [
    ...commandCodeCreditMetrics(credits),
    ...commandCodeSubscriptionMetrics(subscription),
    ...commandCodeSummaryMetrics(summary),
    ...commandCodeAccountMetrics(account),
  ];
  if (!buckets.length && !metrics.length) throw new Error("Command Code returned no quota data.");
  return { providerId: "commandcode", providerName: PROVIDER_NAMES.commandcode, capturedAt, buckets, metrics };
}

function normalizeCommandCodeWindows(input: unknown): UsageBucket[] {
  const windows = record(input);
  return ([
    ["fiveHour", "5h", 300],
    ["weekly", "Weekly", 10_080],
  ] as const).flatMap(([key, label, windowMinutes]) => {
    const window = record(windows?.[key]);
    const used = number(window?.used);
    const cap = number(window?.cap);
    if (used === undefined || cap === undefined || cap <= 0) return [];
    const remaining = clamp(((cap - used) / cap) * 100);
    const resetsAt = epochSeconds(window?.resetAt);
    return [{
      id: key,
      label,
      used: 100 - remaining,
      remaining,
      limit: 100,
      unit: "percent" as const,
      windowMinutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    }];
  });
}

function commandCodeCreditMetrics(credits?: Record<string, unknown>): UsageMetric[] {
  const sources = record(credits?.credits);
  const sourceValues = [sources?.monthlyCredits, sources?.purchasedCredits, sources?.freeCredits].map(nonnegative);
  const sourcedBalance = sourceValues.reduce<number | undefined>(
    (total, value) => value === undefined ? total : (total ?? 0) + value,
    undefined,
  );
  const balance = nonnegative(credits?.remainingCredits) ?? sourcedBalance;
  return balance === undefined ? [] : [{
    id: "balance", label: "Credits remaining", value: balance, unit: "currency", currency: "USD",
  }];
}

function commandCodeSubscriptionMetrics(subscription?: Record<string, unknown>): UsageMetric[] {
  const data = record(subscription?.data) ?? subscription;
  const plan = stringValue(data?.planId);
  return plan ? [{ id: "plan", label: "Plan", value: plan }] : [];
}

function commandCodeSummaryMetrics(summary?: Record<string, unknown>): UsageMetric[] {
  if (!summary) return [];
  const cost = number(summary.totalCost);
  const count = number(summary.totalCount);
  const tokens = number(summary.totalTokens) ?? number(summary.tokens);
  return [
    ...(cost === undefined ? [] : [{ id: "period-cost", label: "Period usage", value: cost, unit: "currency" as const, currency: "USD" }]),
    ...(count === undefined ? [] : [{ id: "requests", label: "Requests", value: count, unit: "count" as const }]),
    ...(tokens === undefined ? [] : [{ id: "tokens", label: "Tokens", value: tokens, unit: "count" as const }]),
  ];
}

function commandCodeAccountMetrics(account?: Record<string, unknown>): UsageMetric[] {
  const label = firstString(account?.keyName, account?.login);
  return label ? [{ id: "account", label: "Account", value: label }] : [];
}
function normalizeOpenCodeGo(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  // Go reports only the used percentage of each fixed window plus a reset timestamp.
  const usage = record(payload.usage) ?? payload;
  const labels: Record<string, string> = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };
  const buckets: UsageBucket[] = [];
  for (const [id, raw] of Object.entries(usage)) {
    const window = record(raw);
    if (!window) continue;
    const percent = nonnegative(window.percent ?? window.usagePercent ?? window.usage_percent);
    if (percent === undefined) continue;
    const resetsAt = epochSeconds(window.resetsAt ?? window.resetAt ?? window.resets_at ?? window.reset_at);
    buckets.push({
      id,
      label: labels[id] ?? id,
      used: clamp(percent),
      remaining: 100 - clamp(percent),
      limit: 100,
      unit: "percent",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (!buckets.length) throw new Error("OpenCode Go returned no usage data.");
  return { providerId: "opencode-go", providerName: PROVIDER_NAMES["opencode-go"], capturedAt, buckets, metrics: [] };
}

const KIMI_TIME_UNIT_SECONDS = new Map([
  ["TIME_UNIT_SECOND", 1],
  ["TIME_UNIT_MINUTE", 60],
  ["TIME_UNIT_HOUR", 3_600],
  ["TIME_UNIT_DAY", 86_400],
]);

function normalizeKimiCoding(payload: Record<string, unknown>, capturedAt: number): UsageReport {
  // Counts arrive as decimal strings. `usage` is the plan's overall quota and
  // `limits[]` the rate-limit windows, each with its own duration.
  const buckets: UsageBucket[] = [];
  const addBucket = (id: string, label: string, detail: Record<string, unknown> | undefined, seconds?: number) => {
    const limit = nonnegativeInteger(detail?.limit);
    const used = nonnegativeInteger(detail?.used);
    const remaining = nonnegativeInteger(detail?.remaining)
      ?? (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
    if (limit === undefined || remaining === undefined) return;
    const resetsAt = epochSeconds(detail?.resetTime);
    buckets.push({
      id,
      label,
      used: used ?? Math.max(0, limit - remaining),
      remaining,
      limit,
      unit: "count",
      ...(seconds ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  };
  addBucket("usage", "Overall", record(payload.usage));
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((item, index) => {
    const value = record(item);
    const window = record(value?.window);
    const duration = nonnegative(window?.duration);
    const unitSeconds = KIMI_TIME_UNIT_SECONDS.get(stringValue(window?.timeUnit) ?? "");
    const seconds = duration !== undefined && unitSeconds ? duration * unitSeconds : undefined;
    addBucket(`limit-${index}`, windowLabel(seconds), record(value?.detail), seconds);
  });
  if (!buckets.length) throw new Error("Kimi returned no usage data.");
  const metrics: UsageMetric[] = [];
  const parallel = nonnegativeInteger(record(payload.parallel)?.limit);
  if (parallel !== undefined) metrics.push({ id: "parallel", label: "Parallel requests", value: parallel, unit: "count" });
  const level = stringValue(record(record(payload.user)?.membership)?.level);
  if (level) metrics.push({ id: "membership", label: "Membership", value: level.replace(/^LEVEL_/u, "") });
  return { providerId: "kimi-coding", providerName: PROVIDER_NAMES["kimi-coding"], capturedAt, buckets, metrics };
}

function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "Limit";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 10_080) return "Weekly";
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function bearerToken(value: string | null): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80);
  return cleaned || undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function nonnegative(value: unknown): number | undefined {
  const result = number(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const result = nonnegative(value);
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 64) return value;
  return undefined;
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value >= 1_000_000_000_000 ? value / 1_000 : value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return epochSeconds(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : undefined;
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}
