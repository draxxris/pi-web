import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./project-env-auth.ts");
  } catch {
    return import("./project-env-auth.ts");
  }
}

const { applyProjectEnvKeys, applyProjectEnvFor } = await loadSubject();

/** pi's standard answer for a provider key variable. */
const keyFrom = (name) => (env) => (env[name] === undefined ? undefined : { auth: { apiKey: env[name] } });

/**
 * The parts of a ModelRuntime the mapping uses. `answers` is what pi would
 * answer for a provider given the probe environment — the choice is pi's, so the
 * fake answers it instead of deriving it, and these tests are about what pi-web
 * does with the answer. That pi really answers this way is what the
 * real-runtime tests at the end pin.
 */
function fakeRuntime({ providers, answers = {}, stored = [], statuses = {} }) {
  const set = [];
  return {
    set,
    getProviders: () => providers.map((id) => ({ id })),
    listCredentials: async () => stored.map((providerId) => ({ providerId, type: "api_key" })),
    getProviderAuthStatus: (id) => statuses[id] ?? { configured: false },
    getAuth: async (providerId, { env }) => {
      const answer = answers[providerId];
      return typeof answer === "function" ? answer(env) : undefined;
    },
    setRuntimeApiKey: async (providerId, apiKey) => {
      set.push({ providerId, apiKey });
    },
  };
}

const ANSWERS = {
  openrouter: keyFrom("OPENROUTER_API_KEY"),
  anthropic: keyFrom("ANTHROPIC_API_KEY"),
  moonshotai: keyFrom("MOONSHOT_API_KEY"),
  "moonshotai-cn": keyFrom("MOONSHOT_API_KEY"),
};

test("a project's provider key is set on the session's own runtime", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter", "anthropic"], answers: ANSWERS });

  const applied = await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" });

  assert.deepEqual(applied, [{ provider: "openrouter", name: "OPENROUTER_API_KEY" }]);
  assert.deepEqual(runtime.set, [{ providerId: "openrouter", apiKey: "sk-or-v1-project" }]);
});

test("names that authenticate no provider are ignored", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter"], answers: ANSWERS });

  const applied = await applyProjectEnvKeys(runtime, {
    DATABASE_URL: "postgres://localhost/db",
    MY_TOOL_API_KEY: "not-a-provider-key",
    NEXT_PUBLIC_FEATURE: "1",
  });

  assert.deepEqual(applied, []);
  assert.deepEqual(runtime.set, []);
});

test("a stored credential keeps the provider (pi's own precedence)", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter"], answers: ANSWERS, stored: ["openrouter"] });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" }), []);
  assert.deepEqual(runtime.set, []);
});

test("an explicit models.json key keeps the provider", async () => {
  const runtime = fakeRuntime({
    providers: ["openrouter"],
    answers: ANSWERS,
    statuses: { openrouter: { configured: true, source: "models_json_key" } },
  });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" }), []);
  assert.deepEqual(runtime.set, []);
});

test("one variable can authenticate several providers of the same key", async () => {
  const runtime = fakeRuntime({ providers: ["moonshotai", "moonshotai-cn", "openrouter"], answers: ANSWERS });

  const applied = await applyProjectEnvKeys(runtime, { MOONSHOT_API_KEY: "sk-moonshot" });

  assert.deepEqual(applied.map((entry) => entry.provider), ["moonshotai", "moonshotai-cn"]);
});

test("which of a provider's variables wins is pi's choice, not the file's line order", async () => {
  // pi prefers the second name; the value installed must be that one's.
  const runtime = fakeRuntime({
    providers: ["openrouter"],
    answers: { openrouter: (env) => keyFrom(env.OR_ALT_KEY === undefined ? "OPENROUTER_API_KEY" : "OR_ALT_KEY")(env) },
  });

  const applied = await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "first", OR_ALT_KEY: "second" });

  assert.deepEqual(applied, [{ provider: "openrouter", name: "OR_ALT_KEY" }]);
  assert.deepEqual(runtime.set, [{ providerId: "openrouter", apiKey: "second" }]);
});

test("a provider that resolves a credential of its own is not overridden", async () => {
  // pi answers with a key the file did not supply (a daemon variable, a profile,
  // a stored credential): there is nothing of the project's to install.
  const runtime = fakeRuntime({
    providers: ["openrouter", "amazon-bedrock"],
    answers: {
      openrouter: () => ({ auth: { apiKey: "sk-or-v1-from-the-daemon" } }),
      "amazon-bedrock": () => ({ auth: { apiKey: "<authenticated>" } }),
    },
  });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" }), []);
  assert.deepEqual(runtime.set, []);
});

test("a marker inside a longer value is not an index", async () => {
  // A `models.json` apiKey of `${NAME}0` resolves to a marker plus a digit: it
  // must not be read as another variable's index.
  const runtime = fakeRuntime({
    providers: ["openrouter"],
    answers: { openrouter: () => ({ auth: { apiKey: "\u0000pi-web-project-env:0" } }) },
  });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" }), []);
});

test("a provider that also needs another value from the file is left alone", async () => {
  // Cloudflare needs the account id beside the key; a runtime API key cannot
  // carry it, so half a configuration is not written.
  const runtime = fakeRuntime({
    providers: ["cloudflare-workers-ai"],
    answers: {
      "cloudflare-workers-ai": (env) => (env.CLOUDFLARE_ACCOUNT_ID === undefined
        ? undefined
        : { auth: { apiKey: env.CLOUDFLARE_API_KEY }, env: { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } }),
    },
  });

  const applied = await applyProjectEnvKeys(runtime, {
    CLOUDFLARE_API_KEY: "cf-key",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
  });

  assert.deepEqual(applied, []);
  assert.deepEqual(runtime.set, []);
});

test("a bearer-token variable beside the key still lets the key through", async () => {
  // pi consults ANTHROPIC_AUTH_TOKEN first and answers with a header, which no
  // runtime API key can express: the key variable is asked on its own instead.
  const runtime = fakeRuntime({
    providers: ["anthropic"],
    answers: {
      anthropic: (env) => (env.ANTHROPIC_AUTH_TOKEN !== undefined
        ? { auth: { headers: { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } } }
        : keyFrom("ANTHROPIC_API_KEY")(env)),
    },
  });

  const applied = await applyProjectEnvKeys(runtime, {
    ANTHROPIC_AUTH_TOKEN: "bearer-token",
    ANTHROPIC_API_KEY: "sk-ant-project",
  });

  assert.deepEqual(applied, [{ provider: "anthropic", name: "ANTHROPIC_API_KEY" }]);
  assert.deepEqual(runtime.set, [{ providerId: "anthropic", apiKey: "sk-ant-project" }]);
});

test("a bearer token alone is not installed as an API key", async () => {
  const runtime = fakeRuntime({
    providers: ["anthropic"],
    answers: {
      anthropic: (env) => (env.ANTHROPIC_AUTH_TOKEN === undefined
        ? undefined
        : { auth: { headers: { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } } }),
    },
  });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { ANTHROPIC_AUTH_TOKEN: "bearer-token" }), []);
  assert.deepEqual(runtime.set, []);
});

test("a provider whose auth resolution throws does not stop the others", async () => {
  const runtime = fakeRuntime({ providers: ["broken", "openrouter"], answers: ANSWERS });
  runtime.getAuth = async (providerId, { env }) => {
    if (providerId === "broken") throw new Error("auth resolution failed");
    return providerId === "openrouter" ? { auth: { apiKey: env.OPENROUTER_API_KEY } } : undefined;
  };

  assert.deepEqual(
    (await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" })).map((e) => e.provider),
    ["openrouter"],
  );
});

test("a provider that refuses the credential does not stop the others", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter", "anthropic"], answers: ANSWERS });
  runtime.setRuntimeApiKey = async (providerId, apiKey) => {
    if (providerId === "openrouter") throw new Error("credential synchronization failed");
    runtime.set.push({ providerId, apiKey });
  };

  const applied = await applyProjectEnvKeys(runtime, {
    OPENROUTER_API_KEY: "sk-or-v1-project",
    ANTHROPIC_API_KEY: "sk-ant-project",
  });

  assert.deepEqual(applied, [{ provider: "anthropic", name: "ANTHROPIC_API_KEY" }]);
  assert.deepEqual(runtime.set, [{ providerId: "anthropic", apiKey: "sk-ant-project" }]);
});

test("blank values and an empty file change nothing", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter"], answers: ANSWERS });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "   " }), []);
  assert.deepEqual(await applyProjectEnvKeys(runtime, {}), []);
  assert.deepEqual(runtime.set, []);
});

test("what is reported names the variable, never its value", async () => {
  const runtime = fakeRuntime({ providers: ["openrouter"], answers: ANSWERS });

  const applied = await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-secret" });

  assert.equal(JSON.stringify(applied).includes("sk-or-v1-secret"), false);
});

// ── Against the real provider table and trust store ─────────────────────────

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

/** A runtime over built-in providers only: no models.json, no network, no key store entries. */
async function realRuntime(authEntries = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-project-env-auth-"));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify(authEntries));
  return ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
}

test("pi maps OPENROUTER_API_KEY to the openrouter provider's API key", async () => {
  const runtime = await realRuntime();

  const applied = await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" });

  assert.deepEqual(applied, [{ provider: "openrouter", name: "OPENROUTER_API_KEY" }]);
  assert.deepEqual(runtime.getProviderAuthStatus("openrouter"), { configured: true, source: "runtime" });
  assert.equal((await runtime.getAuth("openrouter")).auth.apiKey, "sk-or-v1-project");
});

test("an API key stored for the provider is not replaced by the project's", async () => {
  const runtime = await realRuntime({ openrouter: { type: "api_key", key: "sk-or-v1-stored" } });

  assert.deepEqual(await applyProjectEnvKeys(runtime, { OPENROUTER_API_KEY: "sk-or-v1-project" }), []);
  assert.equal((await runtime.getAuth("openrouter")).auth.apiKey, "sk-or-v1-stored");
});

test("a bearer-token variable is not installed as an API key", async () => {
  const runtime = await realRuntime();

  // pi sends ANTHROPIC_AUTH_TOKEN as `Authorization: Bearer`; a runtime API key
  // would be sent as `x-api-key`, so this name must not match on its own.
  assert.deepEqual(await applyProjectEnvKeys(runtime, { ANTHROPIC_AUTH_TOKEN: "bearer-token" }), []);
  assert.deepEqual(
    (await applyProjectEnvKeys(runtime, { ANTHROPIC_API_KEY: "sk-ant-project" })).map((e) => e.provider),
    ["anthropic"],
  );
});

test("the daemon's own environment does not cause an override", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-v1-daemon";
  try {
    const runtime = await realRuntime();

    // The file sets no provider key; nothing may be pinned from process.env.
    assert.deepEqual(await applyProjectEnvKeys(runtime, { MY_TOOL_API_KEY: "not-a-provider-key" }), []);
    assert.deepEqual(runtime.getProviderAuthStatus("openrouter"), { configured: false });
    // …and the daemon's key still resolves on its own, as before.
    assert.equal((await runtime.getAuth("openrouter")).auth.apiKey, "sk-or-v1-daemon");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

/** A project folder with a `.env`, plus an agent dir that holds the trust store. */
function project(name, envText) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-project-env-for-"));
  const cwd = join(root, name);
  mkdirSync(cwd);
  if (envText !== undefined) writeFileSync(join(cwd, ".env"), envText);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  return { cwd, agentDir, setTrust: (entries) => writeFileSync(join(agentDir, "trust.json"), JSON.stringify(entries)) };
}

test("applyProjectEnvFor reads a trusted project's .env", async () => {
  const { cwd, agentDir } = project("repo", "OPENROUTER_API_KEY=sk-or-v1-project\n");
  const runtime = await realRuntime();

  await applyProjectEnvFor(runtime, cwd, agentDir);

  assert.equal((await runtime.getAuth("openrouter")).auth.apiKey, "sk-or-v1-project");
});

test("applyProjectEnvFor ignores a project its trust store distrusts", async () => {
  const { cwd, agentDir, setTrust } = project("repo", "OPENROUTER_API_KEY=sk-or-v1-project\n");
  setTrust({ [cwd]: false });
  const runtime = await realRuntime();

  await applyProjectEnvFor(runtime, cwd, agentDir);

  assert.deepEqual(runtime.getProviderAuthStatus("openrouter"), { configured: false });
});

test("applyProjectEnvFor ignores a folder waiting on a trust decision", async () => {
  const { cwd, agentDir } = project("repo", "OPENROUTER_API_KEY=sk-or-v1-project\n");
  // Trust-requiring resources with nothing decided yet.
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  const runtime = await realRuntime();

  await applyProjectEnvFor(runtime, cwd, agentDir);

  assert.deepEqual(runtime.getProviderAuthStatus("openrouter"), { configured: false });
});

test("applyProjectEnvFor never throws, whatever the trust store says", async () => {
  const { cwd, agentDir, setTrust } = project("repo", "OPENROUTER_API_KEY=sk-or-v1-project\n");
  setTrust(null);
  writeFileSync(join(agentDir, "trust.json"), "{ not json");
  const runtime = await realRuntime();

  assert.deepEqual(await applyProjectEnvFor(runtime, cwd, agentDir), []);
  assert.deepEqual(runtime.getProviderAuthStatus("openrouter"), { configured: false });
});
