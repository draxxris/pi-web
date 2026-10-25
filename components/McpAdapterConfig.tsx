"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shortenPath as displayPath } from "@/lib/display-path";
import type {
  McpAdapterAction,
  McpAdapterErrorResponse,
  McpAdapterOverview,
  McpAdapterServer,
  McpAdapterState,
} from "@/lib/mcp-adapter-types";
import { revealHiddenCharacters } from "@/lib/mcp-server-display";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigNotice,
  ConfigPanelShell,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

// Settings › MCP › Adapter (docs/agents/mcp-adapter.md): pi-mcp-adapter's
// servers from its files, their live state from a running session, and the
// switches that write the adapter's own override file.

const STATE_LABEL_KEYS: Record<McpAdapterState, string> = {
  connected: "mcp.adapter.state.connected",
  "needs-auth": "mcp.adapter.state.needs-auth",
  failed: "mcp.adapter.state.failed",
  cached: "mcp.adapter.state.cached",
  "not-connected": "mcp.adapter.state.not-connected",
  blocked: "mcp.adapter.state.blocked",
  disabled: "mcp.adapter.state.disabled",
  unknown: "mcp.adapter.state.unknown",
};

type Tone = "on" | "off" | "warning" | "error";

function stateTone(state: McpAdapterState): Tone {
  if (state === "connected") return "on";
  if (state === "failed") return "error";
  if (state === "needs-auth" || state === "blocked") return "warning";
  return "off";
}

function dot(tone: Tone): { active?: boolean; color?: string } {
  if (tone === "on") return { active: true };
  if (tone === "off") return { active: false };
  return { color: tone === "error" ? "#ef4444" : "#f59e0b" };
}

const LOAD_TIMEOUT_MS = 15_000;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: McpAdapterOverview };

class AdapterRequestError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

async function request(
  cwd: string | null,
  body: { action: McpAdapterAction; name: string; scope: string } | null,
  signal: AbortSignal,
): Promise<McpAdapterOverview> {
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  const response = body
    ? await fetch("/api/mcp/adapter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
        signal: combined,
      })
    : await fetch(`/api/mcp/adapter${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: combined });
  const json = (await response.json()) as McpAdapterOverview | McpAdapterErrorResponse;
  if (!response.ok) {
    const failure = json as McpAdapterErrorResponse;
    throw new AdapterRequestError(failure.error ?? `HTTP ${response.status}`, failure.reason);
  }
  return json as McpAdapterOverview;
}

export function McpAdapterConfig({ cwd, embedded, onClose }: { cwd: string | null; embedded?: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (body: { action: McpAdapterAction; name: string; scope: string } | null) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const loadOverview = async (): Promise<McpAdapterOverview> => {
        try {
          return await request(cwd, null, controller.signal);
        } catch (cause) {
          // A folder the route refuses (`cwd-*`) leaves the global files listable, as the built-in pane does.
          if (cause instanceof AdapterRequestError && cause.reason?.startsWith("cwd-")) return request(null, null, controller.signal);
          throw cause;
        }
      };
      try {
        const data = body ? await request(cwd, body, controller.signal) : await loadOverview();
        if (controller.signal.aborted) return;
        setLoad({ state: "ready", data });
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // A failed change keeps the list; a failed load replaces it.
        if (body) {
          setError(message);
          void loadOverview().then((data) => !controller.signal.aborted && setLoad({ state: "ready", data }), () => {});
        } else setLoad({ state: "error", message });
      }
    },
    [cwd],
  );

  useEffect(() => {
    void run(null);
    return () => controllerRef.current?.abort();
  }, [run]);

  // Live states change while a session runs: refresh quietly while the panel is open.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden && busy === null) void run(null);
    }, 10_000);
    return () => clearInterval(id);
  }, [run, busy]);

  const change = async (server: McpAdapterServer, action: McpAdapterAction) => {
    setBusy(`${action}:${server.name}`);
    await run({ action, name: server.name, scope: server.scope });
    setBusy(null);
  };

  const data = load.state === "ready" ? load.data : null;
  const servers = data?.servers ?? [];
  const selectedServer = servers.find((server) => server.name === selected) ?? servers[0] ?? null;
  const groups = (["global", "project"] as const).map((scope) => ({ scope, servers: servers.filter((server) => server.scope === scope) }));
  const enabled = servers.filter((server) => !server.disabled).length;
  const problems = (data?.files ?? []).filter((file) => file.problem);

  return (
    <ConfigPanelShell embedded={embedded ?? false} title={t("settings.mcp")} closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {data && !data.install.installed && <ConfigNotice>{t("mcp.adapter.notInstalled")}</ConfigNotice>}
            {data?.install.installed && (
              <ConfigNotice>
                {t(data.install.builtinOff ? "mcp.adapter.owns" : "mcp.adapter.bothOn", { version: data.install.version ?? "?" })}
              </ConfigNotice>
            )}
            {data && (
              <ConfigNotice>
                {t(
                  data.liveAgeMs === undefined ? "mcp.adapter.noLive" : "mcp.adapter.live",
                  { seconds: Math.max(0, Math.round((data.liveAgeMs ?? 0) / 1000)) },
                )}
              </ConfigNotice>
            )}
            {groups.map((group) =>
              group.servers.length === 0 ? null : (
                <div key={group.scope} className="config-sidebar-group">
                  <ConfigSidebarGroupLabel>{t(group.scope === "global" ? "mcp.adapter.group.global" : "mcp.adapter.group.project")}</ConfigSidebarGroupLabel>
                  {group.servers.map((server) => {
                    const tone = stateTone(server.state);
                    const name = revealHiddenCharacters(server.name);
                    return (
                      <ConfigSidebarItem
                        key={`${server.scope}:${server.name}`}
                        active={selectedServer?.name === server.name}
                        aria-label={t("mcp.rowLabel", { name, state: t(STATE_LABEL_KEYS[server.state]) })}
                        onClick={() => setSelected(server.name)}
                      >
                        <ConfigStatusDot {...dot(tone)} />
                        <ConfigSidebarText className={`is-grow${tone === "on" ? "" : " is-muted"}`}>{name}</ConfigSidebarText>
                      </ConfigSidebarItem>
                    );
                  })}
                </div>
              ),
            )}
          </ConfigSidebarList>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {load.state === "loading" ? (
              <ConfigEmptyState>{t("i18n.loading")}</ConfigEmptyState>
            ) : load.state === "error" ? (
              <ConfigEmptyState>{t("mcp.adapter.loadFailed", { error: load.message })}</ConfigEmptyState>
            ) : selectedServer ? (
              <AdapterServerDetail server={selectedServer} busy={busy} error={error} onChange={change} />
            ) : (
              <ConfigEmptyState>{t("mcp.adapter.empty")}</ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={problems.length > 0 ? (
          <ConfigFooterStatus
            tone="warning"
            summary={t("mcp.adapter.fileProblems", { count: problems.length })}
            details={problems.map((file) => (
              <>
                <code className="mcp-config-chip">{displayPath(file.path)}</code> {file.problem}
              </>
            ))}
          />
        ) : (
          <ConfigFooterStatus summary={servers.length > 0 ? t("mcp.serverCount", { enabled, total: servers.length }) : t("mcp.adapter.builtinNote")} />
        )}
      >
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
        <ConfigButton variant="secondary" onClick={() => void run(null)} disabled={busy !== null}>
          {t("i18n.refresh")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}

function directToolsText(server: McpAdapterServer, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  const value = server.directTools;
  if (value === undefined) return undefined;
  if (value === true) return t("mcp.adapter.directAll");
  if (value === "search") return t("mcp.adapter.directSearch");
  return value.join(", ");
}

function AdapterServerDetail({
  server,
  busy,
  error,
  onChange,
}: {
  server: McpAdapterServer;
  busy: string | null;
  error: string | null;
  onChange: (server: McpAdapterServer, action: McpAdapterAction) => Promise<void>;
}) {
  const { t } = useI18n();
  const name = revealHiddenCharacters(server.name);
  const direct = directToolsText(server, t);
  const toolCount = server.live ? server.toolCount ?? 0 : server.cachedTools.length;
  return (
    <>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>{name}</ConfigDetailTitle>
          <ConfigScopeTag scope={server.scope}>{t(server.scope === "global" ? "mcp.adapter.group.global" : "mcp.adapter.group.project")}</ConfigScopeTag>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t("mcp.adapter.removeConfirm", { name, file: displayPath(server.file) }))) void onChange(server, "remove");
            }}
          >
            {t("mcp.adapter.remove")}
          </ConfigButton>
          <ConfigSwitch
            checked={!server.disabled}
            loading={busy?.endsWith(`:${server.name}`) ?? false}
            disabled={busy !== null}
            label={t(server.disabled ? "mcp.adapter.turnOn" : "mcp.adapter.turnOff", { name })}
            onChange={(next) => void onChange(server, next ? "enable" : "disable")}
          />
        </ConfigDetailActions>
      </ConfigDetailHeader>
      {error && <ConfigNotice>{error}</ConfigNotice>}
      <ConfigDetailGrid>
        <ConfigDetailGridRow label={t("mcp.adapter.detail.status")} tone="plain">
          {t(STATE_LABEL_KEYS[server.state])}
          {server.failedAgoSeconds !== undefined && ` (${t("mcp.adapter.failedAgo", { seconds: server.failedAgoSeconds })})`}
          {server.blockedReason && ` — ${server.blockedReason}`}
          {!server.live && server.state !== "disabled" && ` · ${t("mcp.adapter.fromFiles")}`}
        </ConfigDetailGridRow>
        {server.description && <ConfigDetailGridRow label={t("mcp.detail.description")} tone="plain">{revealHiddenCharacters(server.description)}</ConfigDetailGridRow>}
        {server.target && (
          <ConfigDetailGridRow label={t(server.transport === "http" ? "mcp.detail.url" : "mcp.detail.command")} mono>
            {revealHiddenCharacters(server.target)}
          </ConfigDetailGridRow>
        )}
        {server.envNames.length > 0 && <ConfigDetailGridRow label={t("mcp.detail.env")} mono>{server.envNames.join(", ")}</ConfigDetailGridRow>}
        {server.headerNames.length > 0 && <ConfigDetailGridRow label={t("mcp.detail.headers")} mono>{server.headerNames.join(", ")}</ConfigDetailGridRow>}
        {server.oauth && <ConfigDetailGridRow label={t("mcp.detail.signIn")} tone="plain">{t("mcp.adapter.oauthNote")}</ConfigDetailGridRow>}
        {direct && <ConfigDetailGridRow label={t("mcp.adapter.detail.directTools")} mono={Array.isArray(server.directTools)}>{direct}</ConfigDetailGridRow>}
        {server.lifecycle && <ConfigDetailGridRow label={t("mcp.adapter.detail.lifecycle")}>{server.lifecycle}</ConfigDetailGridRow>}
        {(toolCount > 0 || server.live) && (
          <ConfigDetailGridRow label={t("mcp.detail.exposure")} tone="plain">
            {t("mcp.adapter.toolCount", { count: toolCount })}
            {server.resourceCount !== undefined && server.resourceCount > 0
              && `, ${t("mcp.adapter.resourceCount", { count: server.resourceCount })}`}
          </ConfigDetailGridRow>
        )}
        {server.cachedTools.length > 0 && !server.live && (
          <ConfigDetailGridRow label={t("mcp.adapter.detail.cachedTools")} mono>{server.cachedTools.join(", ")}</ConfigDetailGridRow>
        )}
        <ConfigDetailGridRow label={t("mcp.detail.file")} mono>
          {server.definedIn.map(displayPath).join(" → ")}
        </ConfigDetailGridRow>
      </ConfigDetailGrid>
      <ConfigNotice>{t("mcp.adapter.overrideNote")}</ConfigNotice>
    </>
  );
}
