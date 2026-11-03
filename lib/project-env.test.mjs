import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./project-env.ts");
  } catch {
    return import("./project-env.ts");
  }
}

const {
  parseDotEnv,
  resolveDotEnv,
  readProjectEnv,
  readProjectEnvFor,
  projectEnvFile,
  projectEnvTrust,
  projectEnvVersion,
  PROJECT_ENV_UNTRUSTED,
} = await loadSubject();

/** Every folder trusted / none trusted: these tests are about the files, not trust. */
const ALL_TRUSTED = () => true;

function projectWithEnv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-project-env-"));
  if (contents !== undefined) writeFileSync(join(dir, ".env"), contents);
  return dir;
}

test("reads the assignments a key file actually has", () => {
  const values = parseDotEnv([
    "# keys for this project",
    "",
    "OPENROUTER_API_KEY=sk-or-v1-abc",
    "export DATABASE_URL=postgres://localhost/db",
    "  SPACED_KEY = value with spaces  ",
    "QUERY=https://example.com/a?b=1&c=2",
  ].join("\n"));

  assert.deepEqual(values, {
    OPENROUTER_API_KEY: "sk-or-v1-abc",
    DATABASE_URL: "postgres://localhost/db",
    SPACED_KEY: "value with spaces",
    QUERY: "https://example.com/a?b=1&c=2",
  });
});

test("quotes, comments and escapes keep their dotenv meaning", () => {
  const values = parseDotEnv([
    'DOUBLE="value # not a comment"',
    "SINGLE='single $NO_INTERPOLATION'",
    "UNQUOTED=value # trailing comment",
    'ESCAPED="line\\nbreak"',
    "HASH_IN_VALUE=abc#def",
    "EMPTY=",
  ].join("\n"));

  assert.equal(values.DOUBLE, "value # not a comment");
  // No interpolation: the file's meaning never depends on read order.
  assert.equal(values.SINGLE, "single $NO_INTERPOLATION");
  assert.equal(values.UNQUOTED, "value");
  assert.equal(values.ESCAPED, "line\nbreak");
  // A `#` with no whitespace before it is part of the value.
  assert.equal(values.HASH_IN_VALUE, "abc#def");
  assert.equal(values.EMPTY, "");
});

test("a comment after a quoted value does not cut the value at its quote", () => {
  // `lastIndexOf(quote)` would take the apostrophe in the comment as the close.
  const values = parseDotEnv([
    "SINGLE='sk-or-v1-abc' # Gordon's project key",
    'DOUBLE="sk-or-v1-abc" # the "production" key',
    'ESCAPED="quo\\"te" # note',
  ].join("\n"));

  assert.equal(values.SINGLE, "sk-or-v1-abc");
  assert.equal(values.DOUBLE, "sk-or-v1-abc");
  assert.equal(values.ESCAPED, 'quo"te');
});

test("`${NAME}` and `$NAME` resolve, so a key file written as a reference works", () => {
  // The shape a project actually uses: `export OPENROUTER_API_KEY="${OTHER}"`.
  const env = { OPENROUTER_DEVELOPER_API_KEY: "sk-or-v1-real", OTHER: "sk-or-v1-other" };
  const { values, unresolved } = resolveDotEnv([
    'export OPENROUTER_API_KEY="${OPENROUTER_DEVELOPER_API_KEY}"',
    'SINGLE_QUOTED="$OTHER"',
    "BARE=$OTHER",
  ].join("\n"), (name) => env[name]);

  assert.deepEqual(values, {
    OPENROUTER_API_KEY: "sk-or-v1-real",
    SINGLE_QUOTED: "sk-or-v1-other",
    BARE: "sk-or-v1-other",
  });
  assert.deepEqual(unresolved, []);
});

test("a reference to another entry of the file resolves, chains included", () => {
  const { values } = resolveDotEnv([
    "OPENROUTER_API_KEY=${PREFIX}-suffix",
    "PREFIX=sk-or-v1",
  ].join("\n"), () => undefined);

  // The reference precedes its target in the file: order must not matter.
  assert.equal(values.OPENROUTER_API_KEY, "sk-or-v1-suffix");

  const chained = resolveDotEnv("A=${B}\nB=${C}\nC=deep\n", () => undefined);
  assert.deepEqual(chained.values, { A: "deep", B: "deep", C: "deep" });
  assert.deepEqual(chained.unresolved, []);
});

test("a reference nothing can resolve drops that variable, never its template", () => {
  const { values, unresolved } = resolveDotEnv("OPENROUTER_API_KEY=${NOT_SET}\nOTHER=kept\n", () => undefined);

  assert.deepEqual(values, { OTHER: "kept" });
  assert.deepEqual(unresolved, [{ name: "OPENROUTER_API_KEY", missing: "NOT_SET" }]);
});

test("a reference cycle is dropped rather than expanded forever", () => {
  const { values, unresolved } = resolveDotEnv("A=${B}\nB=${A}\n", () => undefined);

  assert.deepEqual(values, {});
  assert.equal(unresolved.length, 2);
});

test("readProjectEnv resolves against the daemon's environment", () => {
  process.env.PI_WEB_TEST_REFERRED = "sk-or-v1-from-the-daemon";
  try {
    const cwd = projectWithEnv('export OPENROUTER_API_KEY="${PI_WEB_TEST_REFERRED}"\n');

    const read = readProjectEnv(cwd, true);

    assert.equal(read.values.OPENROUTER_API_KEY, "sk-or-v1-from-the-daemon");
    assert.equal(read.problem, undefined);
  } finally {
    delete process.env.PI_WEB_TEST_REFERRED;
  }
});

test("readProjectEnv names the reference it could not resolve", () => {
  const cwd = projectWithEnv("OPENROUTER_API_KEY=${PI_WEB_NOT_SET_ANYWHERE}\n");

  const read = readProjectEnv(cwd, true);

  assert.deepEqual(read.values, {});
  assert.match(read.problem, /OPENROUTER_API_KEY references PI_WEB_NOT_SET_ANYWHERE/);
});

test("CRLF files, a last value winning, and lines that are not assignments", () => {
  const values = parseDotEnv("A=1\r\nB=2\r\nA=3\r\nnot an assignment\r\n1BAD=x\r\ncontin uation\r\n");

  assert.deepEqual(values, { A: "3", B: "2" });
});

test("reads a project's .env when the project is trusted", () => {
  const cwd = projectWithEnv("OPENROUTER_API_KEY=sk-or-v1-project\n");
  const read = readProjectEnv(cwd, true);

  assert.equal(read.values.OPENROUTER_API_KEY, "sk-or-v1-project");
  assert.equal(read.problem, undefined);
  assert.equal(read.path, join(cwd, ".env"));
});

test("an untrusted project's .env is named but never parsed", () => {
  const cwd = projectWithEnv("OPENROUTER_API_KEY=sk-or-v1-project\n");
  const read = readProjectEnv(cwd, false);

  assert.deepEqual(read.values, {});
  assert.equal(read.problem, PROJECT_ENV_UNTRUSTED);
});

test("no file is the ordinary case, and no complaint", () => {
  const read = readProjectEnv(projectWithEnv(undefined), true);

  assert.deepEqual(read.values, {});
  assert.equal(read.problem, undefined);
});

test("a file that cannot be read is reported, not thrown", () => {
  const cwd = projectWithEnv(undefined);
  // A directory where the file would be: readable paths only, no exception out.
  mkdirSync(join(cwd, ".env"));

  const read = readProjectEnv(cwd, true);
  assert.deepEqual(read.values, {});
  assert.match(read.problem, /not a regular file/);
});

test("a key file larger than the cap is refused, not parsed", () => {
  const cwd = projectWithEnv(`OPENROUTER_API_KEY=${"k".repeat(70 * 1024)}\n`);
  const read = readProjectEnv(cwd, true);

  assert.deepEqual(read.values, {});
  assert.match(read.problem, /larger than/);
});

test("a folder that is no worktree reads its own .env and stops there", () => {
  const cwd = projectWithEnv("OPENROUTER_API_KEY=own\n");
  const read = readProjectEnvFor(cwd, ALL_TRUSTED);
  assert.equal(read.values.OPENROUTER_API_KEY, "own");
  assert.equal(projectEnvFile(cwd), join(cwd, ".env"));

  const bare = projectWithEnv(undefined);
  assert.deepEqual(readProjectEnvFor(bare, ALL_TRUSTED).values, {});
  assert.equal(projectEnvFile(bare), join(bare, ".env"));
});

/** `<repoRoot>-worktrees/<dir>` beside a checkout, as `addWorktree()` places them. */
function worktreeOf() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-project-env-wt-"));
  const repo = join(root, "repo");
  const worktree = join(root, "repo-worktrees", "feature");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { repo, worktree };
}

test("a worktree uses the checkout's .env it was created from", () => {
  const { repo, worktree } = worktreeOf();
  // `.env` is gitignored, so only the checkout has the key the worktree runs on.
  writeFileSync(join(repo, ".env"), "OPENROUTER_API_KEY=checkout\n");

  const read = readProjectEnvFor(worktree, ALL_TRUSTED);

  assert.equal(read.values.OPENROUTER_API_KEY, "checkout");
  assert.equal(read.path, join(repo, ".env"));
  assert.equal(projectEnvFile(worktree), join(repo, ".env"));
});

test("a worktree's own .env, even an empty one, is the one read", () => {
  const { repo, worktree } = worktreeOf();
  writeFileSync(join(repo, ".env"), "OPENROUTER_API_KEY=checkout\n");
  writeFileSync(join(worktree, ".env"), "# keys deliberately removed here\n");

  const read = readProjectEnvFor(worktree, ALL_TRUSTED);

  assert.deepEqual(read.values, {});
  assert.equal(read.path, join(worktree, ".env"));
});

test("a worktree's checkout is trusted on its own decision, not the worktree's", () => {
  const { repo, worktree } = worktreeOf();
  writeFileSync(join(repo, ".env"), "OPENROUTER_API_KEY=checkout\n");
  // The worktree is trusted, its checkout is not.
  const read = readProjectEnvFor(worktree, (folder) => folder !== repo);

  assert.deepEqual(read.values, {});
  assert.equal(read.problem, PROJECT_ENV_UNTRUSTED);
});

test("a checkout .env that cannot be read reports that, not silence", () => {
  const { repo, worktree } = worktreeOf();
  mkdirSync(join(repo, ".env"));

  const read = readProjectEnvFor(worktree, ALL_TRUSTED);

  assert.equal(read.path, join(repo, ".env"));
  assert.match(read.problem, /not a regular file/);
});

test("trust is per folder, and undecidable trust closes", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-project-env-trust-"));
  const trusted = projectWithEnv("OPENROUTER_API_KEY=k\n");
  const distrusted = projectWithEnv("OPENROUTER_API_KEY=k\n");
  // The store is a flat map: path -> decision (SDK trust-manager).
  writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [distrusted]: false }));

  const isTrusted = projectEnvTrust(agentDir);
  assert.equal(isTrusted(trusted), true, "a folder with no decision is trusted, as pi resolves it");
  assert.equal(isTrusted(distrusted), false, "a saved Do not trust is honoured");
  assert.equal(isTrusted(join(trusted, "nested-deeper")), true);

  writeFileSync(join(agentDir, "trust.json"), "{ not json");
  assert.equal(isTrusted(trusted), false, "a trust store that cannot be read is not a decision to proceed");
});

test("the version changes when the key file does, for the models cache key", async () => {
  const cwd = projectWithEnv("OPENROUTER_API_KEY=one\n");
  const first = projectEnvVersion(join(cwd, ".env"));
  assert.match(first, /^\d+:\d/);

  writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=one\ntrailing=two\n");
  assert.notEqual(projectEnvVersion(join(cwd, ".env")), first);

  const bare = projectWithEnv(undefined);
  assert.equal(projectEnvVersion(join(bare, ".env")), "none");
});
