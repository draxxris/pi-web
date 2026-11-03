export const SETTINGS_SECTION_VALUES = [
  "general",
  "models",
  "skills",
  "agents",
  "plugins",
  "mcp",
  "schedule",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTION_VALUES)[number];
export type SettingsDetailSection = Exclude<SettingsSection, "general">;

const STORAGE_KEY = "pi-web:settings-navigation";
// Sections that need a project to show anything. Settings › MCP is not one: it
// lists the global mcp.json without a project and adds a Project group with one.
const PROJECT_SECTIONS = new Set<SettingsSection>(["skills", "agents", "plugins"]);

/** Whether a section is unavailable until a project is open. */
export function settingsSectionRequiresProject(section: SettingsSection): boolean {
  return PROJECT_SECTIONS.has(section);
}

/**
 * Settings › Models is hidden in this build. With a project's `.env` supplying
 * provider keys per folder (docs/agents/models.md), the panel can only report
 * the *host's* stored credentials — a project's key is invisible to it — and a
 * key saved there lands in `auth.json`, which owns the provider and so silently
 * defeats every project's `.env`. Hiding the tab keeps the UI from inviting
 * that; nothing behind it is disabled: `/api/models-config`, `/api/auth/**` and
 * `~/.pi/agent/models.json` work exactly as before, and the model picker still
 * reads `/api/models`. Flip this to `true` to bring the tab back.
 */
export const MODELS_SETTINGS_SECTION_ENABLED = false;

/** Whether Settings offers this section at all (before the project check). */
export function settingsSectionAvailable(section: SettingsSection): boolean {
  return section !== "models" || MODELS_SETTINGS_SECTION_ENABLED;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingsNavigationState {
  section?: string;
  selections?: Record<string, string>;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string"
    && SETTINGS_SECTION_VALUES.includes(value as SettingsSection);
}

function readState(storage: StorageLike): SettingsNavigationState {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state = parsed as SettingsNavigationState;
    return {
      section: typeof state.section === "string" ? state.section : undefined,
      selections: state.selections !== null
        && typeof state.selections === "object"
        && !Array.isArray(state.selections)
        ? state.selections
        : undefined,
    };
  } catch {
    return {};
  }
}

function selectionKey(section: SettingsDetailSection, cwd?: string | null): string | null {
  if (section === "models") return section;
  if (cwd) return JSON.stringify([section, cwd]);
  // MCP works without a project; its selection then lives under the bare name,
  // which no project key (always an array) can collide with.
  return section === "mcp" ? section : null;
}

export function getLastSettingsSection(
  cwd: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): SettingsSection {
  if (!storage) return "general";
  try {
    const section = readState(storage).section;
    if (!isSettingsSection(section) || !settingsSectionAvailable(section)) return "general";
    return settingsSectionRequiresProject(section) && !cwd ? "general" : section;
  } catch {
    return "general";
  }
}

export function setLastSettingsSection(
  section: SettingsSection,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const state = readState(storage);
    state.section = section;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser storage is best-effort.
  }
}

export function getLastSettingsSelection(
  section: SettingsDetailSection,
  cwd?: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  if (!storage) return null;
  const key = selectionKey(section, cwd);
  if (!key) return null;
  try {
    const value = readState(storage).selections?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setLastSettingsSelection(
  section: SettingsDetailSection,
  value: string,
  cwd?: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !value) return;
  const key = selectionKey(section, cwd);
  if (!key) return;
  try {
    const state = readState(storage);
    state.selections = { ...state.selections, [key]: value };
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser storage is best-effort.
  }
}
