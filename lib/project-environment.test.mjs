import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  bindProjectEnvironmentToModelRuntime,
  findNearestMiseConfigDir,
  loadProjectEnvironment,
  parseMiseEnvironment,
  refreshProjectModelRuntime,
  withoutPiMiseExtension,
} =
  await createJiti(import.meta.url).import("./project-environment.ts");

test("parses only string values from mise environment JSON", () => {
  assert.deepEqual(
    parseMiseEnvironment(JSON.stringify({ PATH: "/bin", PROJECT_FLAG: "enabled", ignored: 42, empty: null })),
    { PATH: "/bin", PROJECT_FLAG: "enabled" },
  );
});

test("rejects malformed mise environment JSON", () => {
  assert.throws(() => parseMiseEnvironment("not-json"), /mise returned invalid JSON/);
  assert.throws(() => parseMiseEnvironment("[]"), /mise returned a non-object environment/);
});

test("finds the nearest mise configuration directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mise-"));
  try {
    const nested = join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "mise.toml"), "[env]\nPROJECT_FLAG = 'enabled'\n", "utf8");

    assert.equal(findNearestMiseConfigDir(nested), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads mise variables for the session cwd without mutating the inherited environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mise-env-"));
  try {
    const nested = join(root, "src");
    const bin = join(root, "bin");
    await mkdir(nested, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, "mise.toml"), "[env]\nPROJECT_FLAG = 'enabled'\n", "utf8");
    const mise = join(bin, "mise");
    await writeFile(
      mise,
      "#!/bin/sh\nif [ \"$1\" = \"env\" ]; then printf '%s' '{\"PROJECT_FLAG\":\"enabled\",\"PROJECT_PATH\":\"/project/bin\"}'; fi\n",
      "utf8",
    );
    await chmod(mise, 0o755);

    const inherited = { PATH: `${bin}:/usr/bin`, HOME: "/home/pi" };
    const environment = await loadProjectEnvironment(nested, inherited);

    assert.equal(environment.PROJECT_FLAG, "enabled");
    assert.equal(environment.PROJECT_PATH, "/project/bin");
    assert.equal(inherited.PROJECT_FLAG, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withoutPiMiseExtension removes only the pi-mise extension", () => {
  const base = {
    extensions: [
      { path: "/home/pi/.pi/agent/npm/node_modules/@capotej/pi-mise/dist/index.js", sourceInfo: { source: "npm:@capotej/pi-mise" }, tools: new Map() },
      { path: "/home/pi/.pi/agent/npm/node_modules/other-ext/dist/index.js", sourceInfo: { source: "npm:other-ext" }, tools: new Map() },
    ],
    errors: [
      { path: "/home/pi/.pi/agent/npm/node_modules/@capotej/pi-mise/dist/index.js", error: "boom" },
      { path: "/other", error: "boom" },
    ],
    runtime: {},
  };
  const filtered = withoutPiMiseExtension(base);
  assert.equal(filtered.extensions.length, 1);
  assert.equal(filtered.extensions[0].path, "/home/pi/.pi/agent/npm/node_modules/other-ext/dist/index.js");
  assert.equal(filtered.errors.length, 1);
  assert.equal(filtered.errors[0].path, "/other");
});

test("project environment overrides stored provider credentials without changing process.env", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  let environment = {
    ...process.env,
    OPENROUTER_API_KEY: "project-key",
    PROJECT_ONLY: "enabled",
  };
  let managedEnvironment = { OPENROUTER_API_KEY: "project-key" };
  const projectEnvironment = {
    cwd: process.cwd(),
    getEnvironment: () => environment,
    getManagedEnvironment: () => managedEnvironment,
    async reload() {},
  };
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

  await bindProjectEnvironmentToModelRuntime(runtime, projectEnvironment);
  const model = runtime.getModel("openrouter", "openai/gpt-4o");
  assert.ok(model);
  const prepared = await runtime.prepareRequest(model, {});

  assert.equal((await runtime.getAuth(model))?.auth.apiKey, "project-key");
  assert.equal(prepared.options.apiKey, "project-key");
  assert.equal(prepared.options.env.PROJECT_ONLY, "enabled");
  assert.equal(process.env.OPENROUTER_API_KEY, originalKey);

  environment = { ...environment, OPENROUTER_API_KEY: "rotated-key" };
  managedEnvironment = { OPENROUTER_API_KEY: "rotated-key" };
  await refreshProjectModelRuntime(runtime);
  assert.equal((await runtime.getAuth(model))?.auth.apiKey, "rotated-key");
});

