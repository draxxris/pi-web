"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import { isProviderUsageId } from "@/lib/provider-usage-ids";

type UsageBucket = {
  id: string;
  label: string;
  groupLabel?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: "percent" | "currency" | "count";
  currency?: string;
  windowMinutes?: number;
  resetsAt?: number;
  period?: string;
};

type UsageMetric = { id: string; label: string; value: number | string; unit?: string; currency?: string };
type UsageReport = { capturedAt: number; buckets: UsageBucket[]; metrics: UsageMetric[]; notes?: string[] };
type UsageResponse = { providerId: string; status: "ready" | "auth-unavailable" | "query-failed"; report?: UsageReport; message?: string };
type Translate = (key: string, params?: Record<string, string | number>) => string;

const STORAGE_PREFIX = "pi-web:provider-usage:";

function readCachedUsage(providerId: string): UsageResponse | null {
  let cached: string | null;
  try {
    cached = localStorage.getItem(`${STORAGE_PREFIX}${providerId}`);
  } catch {
    return null;
  }
  if (!cached) return null;
  try {
    const parsed: unknown = JSON.parse(cached);
    if (isCachedUsage(parsed)) return parsed;
  } catch {
    // Invalid cache data is discarded below.
  }
  try { localStorage.removeItem(`${STORAGE_PREFIX}${providerId}`); } catch {}
  return null;
}

function isCachedUsage(value: unknown): value is UsageResponse {
  if (!value || typeof value !== "object") return false;
  const usage = value as UsageResponse;
  const report = usage.report;
  return usage.status === "ready" && !!report
    && Array.isArray(report.buckets) && Array.isArray(report.metrics)
    && !hasLegacyAnthropicCliBuckets(usage);
}

function hasLegacyAnthropicCliBuckets(usage: UsageResponse): boolean {
  if (usage.providerId !== "anthropic" || !usage.report) return false;
  return usage.report.buckets.some((bucket) =>
    typeof bucket?.id === "string" && bucket.id.startsWith("cli-"),
  );
}
function cacheUsage(providerId: string, snapshot: UsageResponse): void {
  try { localStorage.setItem(`${STORAGE_PREFIX}${providerId}`, JSON.stringify(snapshot)); } catch {}
}

async function requestUsage(providerId: string, failedMessage: string): Promise<UsageResponse> {
  try {
    const response = await fetch("/api/provider-usage/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    const result = await response.json() as UsageResponse & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  } catch (error) {
    return {
      providerId,
      status: "query-failed",
      message: error instanceof Error ? error.message : failedMessage,
    };
  }
}

export function ProviderUsageSummary({
  providerId,
  enabled,
  autoRefresh = false,
  displayName,
  balanceOnly = false,
  showProgress = false,
}: {
  providerId: string;
  enabled: boolean;
  autoRefresh?: boolean;
  displayName?: string;
  balanceOnly?: boolean;
  showProgress?: boolean;
}) {
  if (!isProviderUsageId(providerId)) return null;
  return (
    <ProviderUsageContent
      providerId={providerId}
      enabled={enabled}
      autoRefresh={autoRefresh}
      displayName={displayName}
      balanceOnly={balanceOnly}
      showProgress={showProgress}
    />
  );
}

function ProviderUsageContent({ providerId, enabled, autoRefresh, displayName, balanceOnly, showProgress }: {
  providerId: string;
  enabled: boolean;
  autoRefresh: boolean;
  displayName?: string;
  balanceOnly: boolean;
  showProgress: boolean;
}) {
  const { locale, t } = useI18n();
  const usage = useProviderUsage(providerId, enabled, autoRefresh, t);
  const visible = visibleUsageRows(usage.snapshot, balanceOnly);

  return (
    <ProviderUsageCard
      title={displayName ?? t("providerUsage.usage")}
      panelCard={Boolean(displayName)}
      enabled={enabled}
      usage={usage}
      report={visible.report}
      error={usage.error}
      buckets={visible.buckets}
      metrics={visible.metrics}
      balanceOnly={balanceOnly}
      showProgress={showProgress}
      translate={t}
      locale={locale}
    />
  );
}

function visibleUsageRows(snapshot: UsageResponse | null, balanceOnly: boolean): {
  report: UsageReport | undefined;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
} {
  const report = snapshot?.status === "ready" ? snapshot.report : undefined;
  return {
    report,
    buckets: balanceOnly ? [] : report?.buckets ?? [],
    metrics: report?.metrics.filter((metric) => !balanceOnly || metric.id === "balance") ?? [],
  };
}

function ProviderUsageCard({ title, panelCard, enabled, usage, report, error, buckets, metrics, balanceOnly, showProgress, translate: t, locale }: {
  title: string;
  panelCard: boolean;
  enabled: boolean;
  usage: ReturnType<typeof useProviderUsage>;
  report?: UsageReport;
  error: string | null;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  balanceOnly: boolean;
  showProgress: boolean;
  translate: Translate;
  locale: ReturnType<typeof useI18n>["locale"];
}) {
  return (
    <section style={{ padding: panelCard ? "8px 12px" : "10px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, lineHeight: 1.35 }}>{title}</span>
        <RefreshButton enabled={enabled} usage={usage} translate={t} />
        {report && <span title={new Date(report.capturedAt).toLocaleString(locale)} style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {t("providerUsage.updated", { time: formatUpdatedTime(report.capturedAt, locale) })}
        </span>}
        {/* A failure rides the header row, beside the time it failed after. */}
        {error && <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>{error}</span>}
      </div>
      <UsageStatus report={report} balanceOnly={balanceOnly} metrics={metrics} translate={t} />
      <UsageReportRows report={report} buckets={buckets} metrics={metrics} showProgress={showProgress} availableLabel={t("providerUsage.available")} />
    </section>
  );
}

function UsageReportRows({ report, buckets, metrics, showProgress, availableLabel }: {
  report?: UsageReport;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  showProgress: boolean;
  availableLabel: string;
}) {
  if (!report || (buckets.length === 0 && metrics.length === 0)) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: showProgress ? "minmax(110px, 150px) auto minmax(70px, 1fr) auto" : "minmax(110px, 150px) minmax(70px, 1fr) auto", columnGap: 12, rowGap: 9, alignItems: "center", minWidth: 0, width: showProgress ? "100%" : "min(100%, 420px)", maxWidth: "100%", fontSize: 12 }}>
      {buckets.map((bucket) => <UsageBucketRow key={bucket.id} bucket={bucket} showProgress={showProgress} availableLabel={availableLabel} />)}
      {metrics.map((metric) => <UsageMetricRow key={metric.id} metric={metric} />)}
    </div>
  );
}

function useProviderUsage(providerId: string, enabled: boolean, autoRefresh: boolean, t: Translate) {
  const [snapshot, setSnapshot] = useState<UsageResponse | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const autoQueryStartedRef = useRef<string | null>(null);

  useEffect(() => {
    setRefreshDone(false);
    setSnapshot(readCachedUsage(providerId));
    setError(null);
  }, [providerId]);

  const query = useCallback(async () => {
    setQuerying(true);
    setError(null);
    const result = await requestUsage(providerId, t("providerUsage.queryFailed"));
    if (result.status === "ready") {
      setSnapshot(result);
      cacheUsage(providerId, result);
      setRefreshDone(true);
      setRefreshVersion((version) => version + 1);
    } else {
      setError(result.message ?? t("providerUsage.queryFailed"));
    }
    setQuerying(false);
  }, [providerId, t]);

  useEffect(() => {
    if (!autoRefresh || !enabled || autoQueryStartedRef.current === providerId) return;
    autoQueryStartedRef.current = providerId;
    void query();
  }, [autoRefresh, enabled, providerId, query]);

  useEffect(() => {
    if (!refreshDone) return;
    const timer = setTimeout(() => setRefreshDone(false), 2000);
    return () => clearTimeout(timer);
  }, [refreshDone, refreshVersion]);

  return { snapshot, querying, error, refreshDone, query };
}

function RefreshButton({ enabled, usage, translate: t }: {
  enabled: boolean;
  usage: ReturnType<typeof useProviderUsage>;
  translate: Translate;
}) {
  const state = usage.refreshDone ? "done" : "idle";
  const disabled = !enabled || usage.querying;
  const disabledStyle = disabled ? { cursor: "default" } : { cursor: "pointer" };
  return (
    <button
      type="button"
      onClick={usage.query}
      disabled={disabled}
      title={t(usage.querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
      aria-label={t(usage.querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
      style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 30, padding: 0, background: "none", border: "none", color: state === "done" ? "#4ade80" : "var(--text-dim)", borderRadius: 5, flexShrink: 0, opacity: enabled ? 1 : 0.6, transition: "color 0.3s", ...disabledStyle }}
    >
      <RefreshIndicator completed={state === "done"} querying={usage.querying} />
    </button>
  );
}

function RefreshIndicator({ completed, querying }: { completed: boolean; querying: boolean }) {
  if (completed) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function UsageStatus({ report, balanceOnly, metrics, translate: t }: {
  report?: UsageReport;
  balanceOnly: boolean;
  metrics: UsageMetric[];
  translate: Translate;
}) {
  if (!report) return <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("providerUsage.notQueried")}</span>;
  if (balanceOnly && metrics.length === 0) return <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("providerUsage.balanceUnavailable")}</span>;
  return null;
}

function UsageBucketRow({ bucket, showProgress, availableLabel }: {
  bucket: UsageBucket;
  showProgress: boolean;
  availableLabel: string;
}) {
  const remaining = remainingPercent(bucket);
  const hasProgress = showProgress && bucket.unit === "percent" && remaining !== undefined;
  return (
    <>
      <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {bucket.groupLabel ? `${bucket.groupLabel} / ${bucket.label}` : bucket.label}
      </span>
      {hasProgress ? (
        <>
          <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {Math.round(remaining)}%
          </span>
          <ProgressBar bucket={bucket} remaining={remaining} availableLabel={availableLabel} />
        </>
      ) : (
        <span style={{ gridColumn: "2 / -1", color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {formatBucket(bucket, availableLabel)}
        </span>
      )}
      {hasProgress && <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{bucket.resetsAt ? formatReset(bucket.resetsAt) : ""}</span>}
    </>
  );
}

function ProgressBar({ bucket, remaining, availableLabel }: {
  bucket: UsageBucket;
  remaining: number;
  availableLabel: string;
}) {
  const color = remaining <= 20 ? "#ef4444" : remaining <= 50 ? "#eab308" : "var(--accent)";
  return (
    <div
      role="progressbar"
      aria-label={`${bucket.groupLabel ? `${bucket.groupLabel} ` : ""}${bucket.label} remaining`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remaining}
      title={formatBucket(bucket, availableLabel)}
      style={{ height: 8, overflow: "hidden", borderRadius: 999, background: "var(--bg-hover)", minWidth: 0 }}
    >
      <div style={{ width: `${remaining}%`, height: "100%", borderRadius: 999, background: color, transition: "width 0.25s ease" }} />
    </div>
  );
}

function UsageMetricRow({ metric }: { metric: UsageMetric }) {
  return (
    <>
      <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{metric.label}</span>
      <span style={{ gridColumn: "2 / -1", color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatMetric(metric)}</span>
    </>
  );
}

function formatBucket(bucket: UsageBucket, availableLabel: string): string {
  const formatters: Record<UsageBucket["unit"], (value: UsageBucket, available: string) => string> = {
    percent: formatPercentBucket,
    currency: formatCurrencyBucket,
    count: formatCountBucket,
  };
  return formatters[bucket.unit](bucket, availableLabel);
}

function formatPercentBucket(bucket: UsageBucket, availableLabel: string): string {
  const remaining = remainingPercent(bucket);
  if (remaining === undefined) return bucket.period ?? availableLabel;
  const reset = bucket.resetsAt ? formatReset(bucket.resetsAt) : "";
  return `${Math.round(remaining)}%${reset ? ` / ${reset}` : ""}`;
}

function formatCurrencyBucket(bucket: UsageBucket): string {
  return `${bucket.currency === "CNY" ? "CNY " : "$"}${formatAmount(bucket.remaining ?? bucket.limit)}`;
}

function formatCountBucket(bucket: UsageBucket, availableLabel: string): string {
  if (bucket.remaining !== undefined && bucket.limit !== undefined) return `${formatAmount(bucket.remaining)} / ${formatAmount(bucket.limit)}`;
  return bucket.period ?? availableLabel;
}

function remainingPercent(bucket: UsageBucket): number | undefined {
  const remaining = bucket.remaining ?? (bucket.used !== undefined ? 100 - bucket.used : undefined);
  return remaining === undefined || !Number.isFinite(remaining)
    ? undefined
    : Math.min(100, Math.max(0, remaining));
}

function formatMetric(metric: UsageMetric): string {
  if (metric.unit === "currency") {
    const value = metric.id === "balance" && typeof metric.value === "number"
      ? metric.value.toFixed(2)
      : String(metric.value);
    return `${metric.currency === "CNY" ? "CNY " : "$"}${value}`;
  }
  return String(metric.value);
}

function formatAmount(value: number | undefined): string {
  return value === undefined ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatReset(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
