import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readRegularFileText } from "./regular-file";
import { getProjectTrustStatus } from "./project-trust";
import { worktreeProjectRoot } from "./worktree";

/**
 * A project's `.env`, read when one of its sessions starts, so that a
 * per-repository provider key (one `OPENROUTER_API_KEY` per project) reaches
 * the model requests of that project only.
 *
 * This is **not** an environment loader. pi-web never puts a project `.env`
 * into `process.env`, into a spawned process or into the shell tools: the only
 * values that leave this module are the ones `lib/project-env-auth.ts` maps to
 * a provider's own API-key variable, and they reach nothing but that provider's
 * credential on the starting session's `ModelRuntime`. A project `.env` is a key
 * file that happens to use env syntax.
 *
 * `${NAME}` and `$NAME` references are resolved the way the project's own
 * tooling resolves them — from the file's other entries first, then from the
 * daemon's environment — because a key file written as
 * `OPENROUTER_API_KEY="${OPENROUTER_DEVELOPER_API_KEY}"` must not send that
 * template as a credential. A reference that cannot be resolved drops that one
 * variable, so the session falls back to the credentials it already has
 * instead of authenticating with a literal `${...}`.
 */

export const PROJECT_ENV_FILENAME = ".env";

/** Far above any real key file; a larger one is refused rather than parsed. */
export const PROJECT_ENV_MAX_BYTES = 64 * 1024;

/** Reported for a project whose `.env` exists but is not trusted (see lib/project-trust.ts). */
export const PROJECT_ENV_UNTRUSTED = "the project is not trusted";

/** Reported for values whose `${NAME}` / `$NAME` reference could not be resolved. */
export const PROJECT_ENV_UNRESOLVED = "unresolved reference in the project .env";

export interface ProjectEnvRead {
  /** Absolute path of the file that was read (the main checkout's, for a worktree). */
  path: string;
  /** Parsed values; empty when the file is absent, refused or unreadable. */
  values: Record<string, string>;
  /** Why an existing file was not used. Reported, not surfaced yet. */
  problem?: string;
}

/**
 * `KEY=VALUE` lines of a `.env` file, as `dotenv` reads the common cases: `#`
 * comments, a leading `export`, CRLF, and values quoted with `'` or `"`.
 * Everything else is read as a literal, and a line that is not a `NAME=value`
 * assignment (a stray continuation, a comment) is skipped.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = assignment.indexOf("=");
    if (equals <= 0) continue;
    const name = assignment.slice(0, equals).trim();
    // Same shape a shell accepts for a name; a value key never has any other.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    values[name] = parseDotEnvValue(assignment.slice(equals + 1).trim());
  }
  return values;
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(.)/g, (match, escaped: string) => DOUBLE_QUOTE_ESCAPES[escaped] ?? match);
}

/**
 * Index of the quote that closes a value which starts with one, or -1 when it is
 * unterminated. The *first* closing quote, not the last: a comment after the
 * value often holds the same character (`KEY='abc' # Gordon's key`), and a value
 * cut at that apostrophe would be a corrupted key rather than a comment. Only a
 * double-quoted value has escapes, so `\"` does not close it.
 */
function closingQuoteIndex(raw: string, quote: string): number {
  for (let index = 1; index < raw.length; index += 1) {
    if (quote === '"' && raw[index] === "\\") {
      index += 1;
      continue;
    }
    if (raw[index] === quote) return index;
  }
  return -1;
}

function parseDotEnvValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = closingQuoteIndex(raw, quote);
    // An unterminated quote takes the rest of the line, as a shell does.
    if (end < 0) return raw.slice(1);
    const inner = raw.slice(1, end);
    return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
  }
  // Unquoted: whitespace before `#` starts a comment (`KEY=value # note`).
  const comment = raw.search(/\s#/);
  return (comment < 0 ? raw : raw.slice(0, comment)).trim();
}

/** `$NAME` or `${NAME}` in a value; a key has no use for a literal one. */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Enough for a reference to a reference; a cycle stops at the leftover check. */
const MAX_EXPANSION_PASSES = 8;

export interface DotEnvResolution {
  values: Record<string, string>;
  /** Variables dropped because their value referenced something unavailable. */
  unresolved: { name: string; missing: string }[];
}

function substituteReferences(
  value: string,
  lookup: (name: string) => string | undefined,
): { value: string; missing?: string } {
  let missing: string | undefined;
  const substituted = value.replace(REFERENCE_PATTERN, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const found = lookup(name);
    if (found === undefined) {
      missing ??= name;
      return match;
    }
    return found;
  });
  return missing === undefined ? { value: substituted } : { value: substituted, missing };
}

function hasReference(value: string): boolean {
  REFERENCE_PATTERN.lastIndex = 0;
  return REFERENCE_PATTERN.test(value);
}

/**
 * A `.env`'s values with `$NAME` / `${NAME}` references resolved, as the
 * project's own tooling resolves them: another entry of the same file first
 * (in any order, chains included), then `external` — the daemon's environment.
 * A value that still references something unavailable is dropped rather than
 * handed on: `OPENROUTER_API_KEY="${NOT_SET}"` must leave the provider alone,
 * not send `${NOT_SET}` as its key.
 */
export function resolveDotEnv(text: string, external: (name: string) => string | undefined): DotEnvResolution {
  const values: Record<string, string> = { ...parseDotEnv(text) };
  const unresolved: { name: string; missing: string }[] = [];
  const drop = (name: string, missing: string) => {
    delete values[name];
    unresolved.push({ name, missing });
  };

  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass += 1) {
    let changed = false;
    for (const [name, value] of Object.entries(values)) {
      if (!hasReference(value)) continue;
      const { value: substituted, missing } = substituteReferences(value, (referenced) => (
        // A value never references itself: that is a cycle, not a lookup.
        referenced === name ? undefined : values[referenced] ?? external(referenced)
      ));
      if (missing !== undefined) {
        drop(name, missing);
        changed = true;
      } else if (substituted !== value) {
        values[name] = substituted;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // A cycle survives the passes: nothing left that looks like a reference is
  // something a provider can be authenticated with.
  for (const [name, value] of Object.entries(values)) {
    if (hasReference(value)) drop(name, "(unresolved reference)");
  }
  return { values, unresolved };
}

/**
 * The project's `.env` at `folder`. A folder that is not trusted is named as the
 * problem but never parsed: its values would otherwise choose where that
 * repository's prompts are sent.
 */
export function readProjectEnv(folder: string, trusted: boolean): ProjectEnvRead {
  const path = join(folder, PROJECT_ENV_FILENAME);
  if (!trusted) {
    return existsSync(path)
      ? { path, values: {}, problem: PROJECT_ENV_UNTRUSTED }
      : { path, values: {} };
  }
  let text: string | undefined;
  try {
    text = readRegularFileText(path, PROJECT_ENV_MAX_BYTES);
  } catch (error) {
    return { path, values: {}, problem: error instanceof Error ? error.message : String(error) };
  }
  // No file is the ordinary case, not a problem: most projects keep their keys
  // in the key store or the daemon's own environment.
  if (text === undefined) return { path, values: {} };
  // The project's own tooling (mise, direnv, a shell sourcing the file) expands
  // these references; a session's provider key has to see the same value.
  const { values, unresolved } = resolveDotEnv(text, (name) => process.env[name]);
  if (unresolved.length === 0) return { path, values };
  const detail = unresolved.map(({ name, missing }) => `${name} references ${missing}`).join("; ");
  return { path, values, problem: `${PROJECT_ENV_UNRESOLVED}: ${detail}` };
}

/**
 * The file a project's read would use: its own `.env`, else the one in the
 * checkout a Pi Web worktree was created from (see `worktreeProjectRoot()`).
 * `.env` is gitignored, so a worktree never has the key its project runs on.
 * Cheap enough for a cache key — no read, no parse, no git.
 */
export function projectEnvFile(cwd: string): string {
  const own = join(cwd, PROJECT_ENV_FILENAME);
  if (existsSync(own)) return own;
  const checkout = worktreeProjectRoot(cwd);
  return checkout === null ? own : join(checkout, PROJECT_ENV_FILENAME);
}

/**
 * Whether a folder's `.env` may be read: that folder's own trust decision, and
 * never while trust could not be decided. A locked or corrupt trust store makes
 * `getProjectTrustStatus()` report `trusted: true` with `decisionError`
 * (lib/project-trust.ts), which is fine for loading settings and wrong here: a
 * key file decides where a repository's prompts go, so this failure closes.
 */
export function projectEnvTrust(agentDir: string): (folder: string) => boolean {
  return (folder) => {
    try {
      const status = getProjectTrustStatus(folder, agentDir);
      return status.trusted && status.decisionError === undefined;
    } catch {
      return false;
    }
  };
}

/**
 * The project's `.env`, falling back to the main checkout's when `cwd` is a
 * Pi Web worktree with none of its own. Trust is asked for the folder each file
 * belongs to — a worktree has no trust decision of its own, being a sibling of
 * its checkout rather than a child, so the checkout's decision is what counts.
 */
export function readProjectEnvFor(cwd: string, isTrusted: (folder: string) => boolean): ProjectEnvRead {
  const own = readProjectEnv(cwd, isTrusted(cwd));
  if (own.problem !== undefined || existsSync(own.path)) return own;
  const checkout = worktreeProjectRoot(cwd);
  if (checkout === null) return own;
  const fromCheckout = readProjectEnv(checkout, isTrusted(checkout));
  return fromCheckout.problem !== undefined || Object.keys(fromCheckout.values).length > 0
    ? fromCheckout
    : own;
}

/**
 * The version of the `.env` a read answered from (its size and modification
 * time), for a cache key: an edited key file must not leave the model picker
 * showing the previous file's providers for the life of an entry (see
 * lib/models-cache.ts).
 */
export function projectEnvVersion(path: string): string {
  try {
    const stats = statSync(path);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : "not-a-file";
  } catch {
    return "none";
  }
}
