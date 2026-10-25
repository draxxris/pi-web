import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "adapter-home-"));
process.env.HOME = home;
const jiti = createJiti(import.meta.url);
const { changeAdapterServer, readAdapterOverview, McpAdapterError } = await jiti.import("./mcp-adapter-config.ts");
const { createAdapterStatusBus, MCP_ADAPTER_STATUS_EVENT, readAdapterLiveStatus, resetAdapterLiveStatusForTests } = await jiti.import("./mcp-adapter-status.ts");

const agentDir = join(home, ".pi", "agent");
const shared = join(home, ".config", "mcp", "mcp.json");
const override = join(agentDir, "mcp-adapter.json");

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

beforeEach(() => {
  resetAdapterLiveStatusForTests();
  write(shared, {
    mcpServers: {
      tav: { url: "https://x.test/mcp?tavilyApiKey=abcdef1234567890abcdef", headers: { Authorization: "Bearer s3cret" }, directTools: ["a"] },
      blender: { command: "uv", args: ["run", "blender-mcp"], env: { TOKEN: "s3cret" } },
    },
  });
  write(override, { mcpServers: {} });
});

test("lists shared servers, masks secrets and never sends values", () => {
  const overview = readAdapterOverview({ agentDir });
  assert.deepEqual(overview.servers.map((s) => s.name).sort(), ["blender", "tav"]);
  const tav = overview.servers.find((s) => s.name === "tav");
  assert.equal(tav.masked, true);
  assert.equal(tav.transport, "http");
  assert.deepEqual(tav.headerNames, ["Authorization"]);
  assert.deepEqual(tav.directTools, ["a"]);
  assert.ok(!JSON.stringify(overview).includes("s3cret"));
  assert.equal(overview.servers.find((s) => s.name === "blender").state, "unknown");
});

test("the adapter override replaces fields and wins", () => {
  write(override, { mcpServers: { blender: { disabled: true } } });
  const blender = readAdapterOverview({ agentDir }).servers.find((s) => s.name === "blender");
  assert.equal(blender.disabled, true);
  assert.equal(blender.state, "disabled");
  assert.equal(blender.target, "uv run blender-mcp");
  assert.equal(blender.file, override);
  assert.deepEqual(blender.definedIn, [shared, override]);
});

test("disable and enable write only the override file", async () => {
  const before = readFileSync(shared, "utf8");
  await changeAdapterServer({ agentDir, action: "disable", name: "blender" });
  assert.deepEqual(JSON.parse(readFileSync(override, "utf8")).mcpServers.blender, { disabled: true });
  assert.equal(readFileSync(shared, "utf8"), before);
  await changeAdapterServer({ agentDir, action: "enable", name: "blender" });
  assert.deepEqual(JSON.parse(readFileSync(override, "utf8")).mcpServers, {});
});

test("enable writes an explicit false when a lower source is disabled", async () => {
  write(shared, { mcpServers: { s: { command: "x", disabled: true } } });
  await changeAdapterServer({ agentDir, action: "enable", name: "s" });
  assert.deepEqual(JSON.parse(readFileSync(override, "utf8")).mcpServers.s, { disabled: false });
});

test("remove deletes from the defining file and refuses a file with comments", async () => {
  await changeAdapterServer({ agentDir, action: "remove", name: "tav" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(shared, "utf8")).mcpServers), ["blender"]);
  write(shared, '{ // note\n "mcpServers": { "b": { "command": "x" } } }');
  await assert.rejects(changeAdapterServer({ agentDir, action: "remove", name: "b" }), (e) => e instanceof McpAdapterError && e.reason === "has-comments");
  await assert.rejects(changeAdapterServer({ agentDir, action: "remove", name: "gone" }), (e) => e.reason === "server-missing");
});

test("a project file is read only inside the allowed roots", () => {
  const project = join(home, "proj");
  write(join(project, ".mcp.json"), { mcpServers: { p: { command: "node" } } });
  const open = readAdapterOverview({ agentDir, project: { cwd: project, allowedRoots: new Set([project]) } });
  assert.equal(open.servers.find((s) => s.name === "p").scope, "project");
  const closed = readAdapterOverview({ agentDir, project: { cwd: project, allowedRoots: new Set(["/nowhere"]) } });
  assert.equal(closed.servers.find((s) => s.name === "p"), undefined);
  assert.equal(closed.files.find((f) => f.id === "shared-project").problem, "link-outside");
});

test("live status from the adapter's event overrides files and clears on shutdown", () => {
  const bus = createAdapterStatusBus("/w");
  bus.emit(MCP_ADAPTER_STATUS_EVENT, { servers: [{ name: "blender", status: "connected", toolCount: 3, directToolCount: 0, disabled: false }] });
  const blender = readAdapterOverview({ agentDir }).servers.find((s) => s.name === "blender");
  assert.equal(blender.state, "connected");
  assert.equal(blender.live, true);
  assert.equal(blender.toolCount, 3);
  bus.emit(MCP_ADAPTER_STATUS_EVENT, { servers: [] });
  assert.equal(readAdapterLiveStatus("/w"), undefined);
});
