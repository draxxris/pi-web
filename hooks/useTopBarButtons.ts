import { useSyncExternalStore } from "react";

/** The chat top bar's optional buttons: Full history, Debug. */
export type TopBarButtonName = "history" | "debug";
export type TopBarButtons = Readonly<Record<TopBarButtonName, boolean>>;

export const TOP_BAR_BUTTONS_STORAGE_KEY = "pi-web:top-bar-buttons";
export const TOP_BAR_BUTTONS_DEFAULT: TopBarButtons = { history: true, debug: true };

// Only a stored `false` hides a button, so a value that is missing, unreadable or from another
// version shows both: a browser that lost its storage keeps the whole top bar.
export function parseTopBarButtons(raw: string | null): TopBarButtons {
  if (!raw) return TOP_BAR_BUTTONS_DEFAULT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return TOP_BAR_BUTTONS_DEFAULT;
  }
  if (!parsed || typeof parsed !== "object") return TOP_BAR_BUTTONS_DEFAULT;
  const record = parsed as Partial<Record<TopBarButtonName, unknown>>;
  return { history: record.history !== false, debug: record.debug !== false };
}

function readStoredButtons(): TopBarButtons {
  try {
    return parseTopBarButtons(window.localStorage.getItem(TOP_BAR_BUTTONS_STORAGE_KEY));
  } catch {
    return TOP_BAR_BUTTONS_DEFAULT;
  }
}

let buttons: TopBarButtons | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): TopBarButtons {
  if (buttons === null) buttons = readStoredButtons();
  return buttons;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== TOP_BAR_BUTTONS_STORAGE_KEY) return;
  const next = readStoredButtons();
  const current = getSnapshot();
  if (next.history === current.history && next.debug === current.debug) return;
  buttons = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    buttons = readStoredButtons();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setTopBarButton(name: TopBarButtonName, visible: boolean): void {
  const current = getSnapshot();
  if (current[name] === visible) return;
  const next: TopBarButtons = { ...current, [name]: visible };
  buttons = next;
  try {
    window.localStorage.setItem(TOP_BAR_BUTTONS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

export function useTopBarButtons(): TopBarButtons {
  return useSyncExternalStore(subscribe, getSnapshot, () => TOP_BAR_BUTTONS_DEFAULT);
}
