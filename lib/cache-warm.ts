import type { ExtensionStatusItem } from "./types";

/**
 * The composer's cache-warm toggle, for the extension that keeps a prompt cache
 * warm (https://github.com/luongnv89/pi-extensions, `cache-warm`). Nothing here
 * reads the installed packages: a session knows what it loaded. Its registered
 * commands say whether the extension is there, and its status key says whether
 * warming is on — the extension clears that status when it switches off, so the
 * cell's presence is the on state. Both reach the page from the session's live
 * state (`extensionCommands` and `extensionStatuses` in `get_state`), which
 * exists only while the session's wrapper is alive, as for every extension
 * status. So the toggle appears once a session has a wrapper, which is when
 * warming can matter: the cache it keeps warm starts with its first turn.
 */
export const CACHE_WARM_COMMAND = "cache-warm";

/** The status the extension sets (`STATUS_KEY` in its `warm.ts`). */
export const CACHE_WARM_STATUS_KEY = "cache-alive-warm";

export interface CacheWarmState {
  /** The session registered the extension's command, so the toggle can send it. */
  installed: boolean;
  /** The extension is warming this session: its status cell is set. */
  enabled: boolean;
  /** The extension's own status text ("warm 3m12s · 4 hits · $0.01"), while warming. */
  statusText: string | null;
}

/** What the composer shows from the live session's extension commands and statuses. */
export function readCacheWarmState(
  commands: readonly string[] | undefined,
  statuses: readonly ExtensionStatusItem[] | undefined,
): CacheWarmState {
  const statusText = statuses?.find((item) => item.key === CACHE_WARM_STATUS_KEY)?.text.trim() ?? "";
  const enabled = statusText.length > 0;
  return {
    // A status cell is also proof the command exists, for a page whose state
    // read raced the extension's first `setStatus`.
    installed: (commands?.includes(CACHE_WARM_COMMAND) ?? false) || enabled,
    enabled,
    statusText: enabled ? statusText : null,
  };
}

/**
 * The command that switches warming to the other state. Explicit `on` / `off`:
 * bare `/cache-warm` opens a settings panel in pi's TUI, and pi's own `on`
 * needs no confirmation of its own outside that panel.
 */
export function cacheWarmToggleCommand(enabled: boolean): string {
  return enabled ? `/${CACHE_WARM_COMMAND} off` : `/${CACHE_WARM_COMMAND} on`;
}
