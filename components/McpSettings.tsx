"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { McpAdapterOverview } from "@/lib/mcp-adapter-types";
import { McpAdapterConfig } from "./McpAdapterConfig";
import { McpConfig } from "./McpConfig";
import { ConfigScopeSwitch } from "./SettingsUi";

type Source = "builtin" | "adapter";

/**
 * Settings › MCP: pi's built-in MCP and pi-mcp-adapter are two different
 * runtimes with their own files, so each has its own pane. The tab opens on the
 * adapter when it is installed and Pi's built-in is turned off (`-builtin:mcp`),
 * the setup where the built-in pane would list nothing a session uses.
 */
export function McpSettings(props: ComponentProps<typeof McpConfig>) {
  const { t } = useI18n();
  const [source, setSource] = useState<Source | null>(null);
  const cwd = props.cwd;

  useEffect(() => {
    if (source !== null) return;
    const controller = new AbortController();
    fetch(`/api/mcp/adapter${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then((response) => (response.ok ? (response.json() as Promise<McpAdapterOverview>) : Promise.reject(new Error(String(response.status)))))
      .then((data) => setSource(data.install.installed && data.install.builtinOff ? "adapter" : "builtin"))
      .catch(() => !controller.signal.aborted && setSource("builtin"));
    return () => controller.abort();
  }, [source, cwd]);

  return (
    <div className="adapter-source-host">
      <div className="adapter-source-bar">
        <ConfigScopeSwitch<Source>
          value={source ?? "builtin"}
          label={t("mcp.source.label")}
          size="small"
          options={[
            { value: "builtin", label: t("mcp.source.builtin") },
            { value: "adapter", label: t("mcp.source.adapter") },
          ]}
          onChange={setSource}
        />
      </div>
      <div className="adapter-source-body">
        {source === "adapter" ? (
          <McpAdapterConfig cwd={cwd} embedded={props.embedded} onClose={props.onClose} />
        ) : source === "builtin" ? (
          <McpConfig {...props} />
        ) : null}
      </div>
    </div>
  );
}
