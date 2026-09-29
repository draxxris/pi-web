import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./provider-usage.ts");
}

const { getProviderUsageVisibility, isOfficialProviderUsageOrigin, isProviderUsageId, normalizeProviderUsagePayload } = await loadSubject();

test("recognizes only providers with usage adapters", () => {
  assert.equal(isProviderUsageId("openai-codex"), true);
  assert.equal(isProviderUsageId("opencode-go"), true);
  assert.equal(isProviderUsageId("anthropic"), true);
  assert.equal(isProviderUsageId("antigravity"), true);
});

test("provider stanza visibility follows the three server API-key variables", () => {
  assert.deepEqual(getProviderUsageVisibility({}), {
    openrouter: false,
    "opencode-go": false,
    commandcode: false,
  });
  assert.deepEqual(getProviderUsageVisibility({
    OPENROUTER_API_KEY: "openrouter",
    OPENCODE_API_KEY: "opencode",
    COMMAND_CODE_API_KEY: "commandcode",
  }), {
    openrouter: true,
    "opencode-go": true,
    commandcode: true,
  });
});

test("accepts only the official origin for provider usage credentials", () => {
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://api.deepseek.com/v1"), true);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://proxy.example.com/v1"), false);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "not a URL"), false);
  assert.equal(isOfficialProviderUsageOrigin("opencode-go", "https://opencode.ai/zen/go/v1"), true);
  assert.equal(isOfficialProviderUsageOrigin("opencode-go", "https://proxy.example.com/zen/go/v1"), false);
  assert.equal(isOfficialProviderUsageOrigin("anthropic", "https://api.anthropic.com"), true);
  assert.equal(isOfficialProviderUsageOrigin("anthropic", "https://proxy.example.com"), false);
  assert.equal(isOfficialProviderUsageOrigin("antigravity", undefined), false);
});

test("normalizes Codex windows into remaining percentages and reset times", () => {
  const report = normalizeProviderUsagePayload("openai-codex", {
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
    },
  }, 123);
  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.groupLabel, bucket.remaining, bucket.resetsAt]), [
    ["5h", undefined, 88, 1_800_000_000],
    ["Weekly", undefined, 60, undefined],
  ]);
});

test("normalizes MiniMax token-plan counts using the reported remaining percent", () => {
  const report = normalizeProviderUsagePayload("minimax", {
    model_remains: [{
      model_name: "MiniMax-M2",
      current_interval_usage_count: 20,
      current_interval_total_count: 100,
      current_interval_remaining_percent: 80,
      current_interval_status: 1,
      start_time: 1_700_000_000_000,
      end_time: 1_700_360_000_000,
      current_weekly_usage_count: 1,
      current_weekly_total_count: 1,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 3,
      weekly_start_time: 1_700_000_000_000,
      weekly_end_time: 1_706_000_000_000,
    }],
  }, 123);
  assert.equal(report.buckets[0].remaining, 80);
  assert.equal(report.buckets[0].used, 20);
  assert.equal(report.buckets[1].period, "Unlimited");
});

test("normalizes Kimi For Coding quota, rate-limit windows and plan details", () => {
  assert.equal(isProviderUsageId("kimi-coding"), true);
  // The provider's base URL; the usage endpoint lives on the same origin.
  assert.equal(isOfficialProviderUsageOrigin("kimi-coding", "https://api.kimi.com/coding"), true);
  assert.equal(isOfficialProviderUsageOrigin("kimi-coding", "https://proxy.example.com/coding"), false);
  // Response sample from #848 (GET https://api.kimi.com/coding/v1/usages).
  const report = normalizeProviderUsagePayload("kimi-coding", {
    user: { membership: { level: "LEVEL_ADVANCED" } },
    usage: { limit: "100", remaining: "100", resetTime: "2026-09-21T03:17:42Z" },
    limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-09-14T10:17:42Z" },
    }],
    parallel: { limit: "30" },
    authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" },
  }, 123);
  assert.deepEqual(report.buckets, [
    { id: "usage", label: "Overall", used: 0, remaining: 100, limit: 100, unit: "count", resetsAt: Math.floor(Date.parse("2026-09-21T03:17:42Z") / 1_000) },
    { id: "limit-0", label: "5h", used: 1, remaining: 99, limit: 100, unit: "count", windowMinutes: 300, resetsAt: Math.floor(Date.parse("2026-09-14T10:17:42Z") / 1_000) },
  ]);
  assert.deepEqual(report.metrics, [
    { id: "parallel", label: "Parallel requests", value: 30, unit: "count" },
    { id: "membership", label: "Membership", value: "ADVANCED" },
  ]);
  assert.throws(() => normalizeProviderUsagePayload("kimi-coding", { usage: { limit: "x" }, limits: [] }), /no usage data/);
});

test("normalizes OpenCode Go windows into remaining percentages and reset times", () => {
  const report = normalizeProviderUsagePayload("opencode-go", {
    usage: {
      rolling: { status: "ok", percent: 3, resetsAt: "2026-09-14T05:53:50.774Z" },
      weekly: { status: "ok", percent: 1, resetsAt: "2026-09-21T00:00:00.774Z" },
      monthly: { status: "ok", percent: 98, resetsAt: "2026-09-19T02:38:27.774Z" },
    },
  }, 123);
  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.remaining, bucket.unit, bucket.resetsAt]), [
    ["Rolling", 97, "percent", Math.floor(Date.parse("2026-09-14T05:53:50.774Z") / 1_000)],
    ["Weekly", 99, "percent", Math.floor(Date.parse("2026-09-21T00:00:00.774Z") / 1_000)],
    ["Monthly", 2, "percent", Math.floor(Date.parse("2026-09-19T02:38:27.774Z") / 1_000)],
  ]);
});

test("normalizes Anthropic subscription windows into remaining quota", () => {
  const report = normalizeProviderUsagePayload("anthropic", {
    five_hour: { utilization: 23, resets_at: "2026-09-28T14:00:00Z" },
    seven_day: { utilization: 41, resets_at: "2026-10-01T19:00:00Z" },
  }, 123);

  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.used, bucket.remaining, bucket.windowMinutes, bucket.resetsAt]), [
    ["Session (5h)", 23, 77, 300, Date.parse("2026-09-28T14:00:00Z") / 1_000],
    ["Weekly", 41, 59, 10_080, Date.parse("2026-10-01T19:00:00Z") / 1_000],
  ]);
});

test("prefers structured Anthropic limits and preserves the session reset time", () => {
  const report = normalizeProviderUsagePayload("anthropic", {
    five_hour: { utilization: 99, resets_at: null },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 37,
        resets_at: "2026-09-28T20:00:00Z",
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 54,
        resets_at: "2026-10-01T23:00:00Z",
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 26,
        resets_at: "2026-10-01T23:00:00Z",
        scope: { model: { display_name: "Claude Sonnet" } },
      },
    ],
  }, 123);

  assert.deepEqual(report.buckets.map(({ label, used, remaining, windowMinutes, resetsAt }) => [
    label,
    used,
    remaining,
    windowMinutes,
    resetsAt,
  ]), [
    ["Session (5h)", 37, 63, 300, Date.parse("2026-09-28T20:00:00Z") / 1_000],
    ["Weekly", 54, 46, 10_080, Date.parse("2026-10-01T23:00:00Z") / 1_000],
    ["Sonnet weekly", 26, 74, 10_080, Date.parse("2026-10-01T23:00:00Z") / 1_000],
  ]);
});

test("uses only Antigravity's Gemini model quota rows", () => {
  const report = normalizeProviderUsagePayload("antigravity", {
    cliResponse: [
      "Gemini Models\tWeekly Limit Remaining\t72%\t2026-09-28T04:15:10Z",
      "Gemini Models\tFive Hour Limit Remaining\t91%\t2026-09-28T07:34:46Z",
      "Claude and GPT models\tWeekly Limit Remaining\t18%\t2026-10-05T02:34:46Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t42%\t2026-09-28T07:34:46Z",
      "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t64%\t2026-10-05T02:34:46Z",
    ].join("\n"),
  }, 123);

  assert.deepEqual(report.buckets.map((bucket) => [bucket.groupLabel, bucket.label, bucket.used, bucket.remaining]), [
    ["Gemini", "Weekly", 28, 72],
    ["Gemini", "5h", 9, 91],
    ["Argon", "Weekly", 36, 64],
  ]);
});

test("normalizes Command Code credits, plan, usage windows, and reset times", () => {
  const report = normalizeProviderUsagePayload("commandcode", {
    account: { login: "user", orgId: "org-1", keyName: "quota key" },
    credits: {
      credits: { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 1 },
      windowLimits: {
        fiveHour: { used: 1.5, cap: 3, resetAt: "1800000000" },
        weekly: { used: 6, cap: 12, resetAt: "2026-09-21T00:00:00Z" },
      },
    },
    subscription: { data: { planId: "goat", status: "active", currentPeriodStart: "2026-09-01" } },
    summary: { totalCost: 4.25, totalCount: 20, totalTokens: 1000 },
  }, 123);

  assert.deepEqual(report.buckets.map(({ label, used, remaining, windowMinutes, resetsAt }) => [
    label, used, remaining, windowMinutes, resetsAt,
  ]), [
    ["5h", 50, 50, 300, 1_800_000_000],
    ["Weekly", 50, 50, 10_080, Date.parse("2026-09-21T00:00:00Z") / 1_000],
  ]);
  assert.deepEqual(report.metrics, [
    { id: "balance", label: "Credits remaining", value: 13, unit: "currency", currency: "USD" },
    { id: "plan", label: "Plan", value: "goat" },
    { id: "period-cost", label: "Period usage", value: 4.25, unit: "currency", currency: "USD" },
    { id: "requests", label: "Requests", value: 20, unit: "count" },
    { id: "tokens", label: "Tokens", value: 1000, unit: "count" },
    { id: "account", label: "Account", value: "quota key" },
  ]);
});

test("reports the OpenRouter account balance independently of key limits", () => {
  const report = normalizeProviderUsagePayload("openrouter", {
    credits: { total_credits: 25, total_usage: 8.756 },
  }, 123);

  assert.deepEqual(report.metrics, [{
    id: "balance",
    label: "Balance remaining",
    value: 16.24,
    unit: "currency",
    currency: "USD",
  }]);
  assert.deepEqual(report.buckets, []);
});
