"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ProviderUsageSummary } from "./ProviderUsageSummary";

const SUBSCRIPTION_PROVIDERS: { id: string; name: string; balanceOnly?: boolean }[] = [
  { id: "openai-codex", name: "Codex" },
  { id: "anthropic", name: "Claude" },
  { id: "antigravity", name: "Antigravity" },
  { id: "opencode-go", name: "OpenCode Go" },
  { id: "openrouter", name: "OpenRouter", balanceOnly: true },
  { id: "commandcode", name: "Command Code" },
] as const;

const QUOTA_BUTTON_RESPONSIVE_STYLES = {
  mobile: { padding: 0 },
  desktop: { padding: "0 12px" },
} as const;

const QUOTA_BUTTON_STATE_STYLES = {
  active: { background: "var(--bg-selected)", borderTop: "2px solid var(--accent)", color: "var(--text)" },
  idle: { background: "none", borderTop: "2px solid transparent", color: "var(--text-muted)" },
} as const;

const DEFAULT_PROVIDER_IDS = new Set(
  SUBSCRIPTION_PROVIDERS.map(({ id }) => id).filter((id) => !["opencode-go", "openrouter", "commandcode"].includes(id)),
);

export function SubscriptionQuotaPanel({ open }: { open: boolean }) {
  const { t } = useI18n();
  const [providerIds, setProviderIds] = useState<Set<string>>(DEFAULT_PROVIDER_IDS);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch("/api/provider-usage/query")
      .then((response) => response.ok ? response.json() as Promise<{ providerIds?: unknown }> : null)
      .then((result) => {
        if (!active || !result || !Array.isArray(result.providerIds)) return;
        setProviderIds(new Set(result.providerIds.filter((id): id is string => typeof id === "string")));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)" }}>
      <div style={{ padding: "10px 16px 4px", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
        {t("quota.title")}
      </div>
      {SUBSCRIPTION_PROVIDERS.filter(({ id }) => providerIds.has(id)).map((provider) => (
        <div key={provider.id} style={{ borderTop: "1px solid var(--border)" }}>
          <ProviderUsageSummary
            providerId={provider.id}
            enabled
            autoRefresh
            displayName={provider.name}
            balanceOnly={provider.balanceOnly}
            showProgress
          />
        </div>
      ))}
    </div>
  );
}

export function SubscriptionQuotaButton({
  active,
  enabled,
  mobile,
  mobileButtonSize,
  onClick,
  label,
  title,
}: {
  active: boolean;
  enabled: boolean;
  mobile: boolean;
  mobileButtonSize: number;
  onClick: () => void;
  label: string;
  title: string;
}) {
  const disabled = mobile && !enabled;
  const responsive = {
    ...QUOTA_BUTTON_RESPONSIVE_STYLES[mobile ? "mobile" : "desktop"],
    ...(mobile ? { width: mobileButtonSize } : {}),
  };
  const visualState = QUOTA_BUTTON_STATE_STYLES[active ? "active" : "idle"];
  const disabledStyle = disabled ? { cursor: "not-allowed", opacity: 0.45 } : {};
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: "100%",
        border: "none",
        borderRight: "1px solid var(--border)",
        cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
        ...responsive,
        ...visualState,
        ...disabledStyle,
      }}
      data-mobile-toolbar-action={mobile ? "quota" : undefined}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true">
        <path d="M4 19a8 8 0 1 1 16 0" />
        <path d="m12 11 4-4" />
        <path d="M4 19h16" />
      </svg>
      {!mobile && <span>{label}</span>}
    </button>
  );
}
