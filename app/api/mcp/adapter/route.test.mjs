import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Settings › MCP › Adapter writes pi-mcp-adapter's files, so every case runs
// against a PI_CODING_AGENT_DIR in a temporary folder, never the real ~/.pi/agent.
const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-mcp-adapter-route-")));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHome = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = agentDir;
// The adapter's shared global file is under the home directory.
process.env.HOME = join(root, "home");
await mkdir(agentDir, { recursive: true });
await mkdir(join(cwd, ".pi"), { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const sharedPath = join(process.env.HOME, ".config", "mcp", "mcp.json");
const overridePath = join(agentDir, "mcp-adapter.json");
const projectPath = join(cwd, ".mcp.json");
const store = new ProjectTrustStore(agentDir);
const SECRET = "literal-header-secret-value";

async function write(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(async () => {
  store.set(cwd, null);
  await write(sharedPath, {
    mcpServers: {
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` }, directTools: ["search"] },
      lint: { command: "npx", args: ["lint-mcp"] },
    },
  });
  await rm(overridePath, { force: true });
  await rm(projectPath, { force: true });
});

async function get(cwdParam) {
  const url = `http://localhost/api/mcp/adapter${cwdParam ? `?cwd=${encodeURIComponent(cwdParam)}` : ""}`;
  const response = await GET(new Request(url, { headers: { host: "localhost" } }));
  return { status: response.status, body: await response.json() };
}

async function post(body, headers = {}) {
  const response = await POST(new Request("http://localhost/api/mcp/adapter", {
    method: "POST",
    headers: { host: "localhost", "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const server = (body, name) => body.servers.find((entry) => entry.name === name);

test("GET lists the adapter's files and drives nothing, and masks secrets as the built-in pane does", async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.equal(body.install.installed, false);
  assert.deepEqual(body.servers.map((entry) => entry.name).sort(), ["docs", "lint"]);
  assert.equal(body.files.find((file) => file.id === "shared-global").serverCount, 2);
  assert.deepEqual(server(body, "docs").headerNames, ["Authorization"]);
  assert.equal(server(body, "docs").transport, "http");
  assert.equal(server(body, "docs").state, "unknown", "no session reported, and no cache file");
  assert.ok(!JSON.stringify(body).includes(SECRET), "no literal value reaches the browser");
});

test("disable and enable write the adapter's override file only", async () => {
  const sharedBefore = await readFile(sharedPath, "utf8");
  let { status, body } = await post({ action: "disable", scope: "global", name: "lint" });
  assert.equal(status, 200);
  assert.equal(server(body, "lint").disabled, true);
  assert.equal(server(body, "lint").state, "disabled");
  assert.deepEqual((await readJson(overridePath)).mcpServers.lint, { disabled: true });
  assert.equal(await readFile(sharedPath, "utf8"), sharedBefore);

  ({ status, body } = await post({ action: "enable", scope: "global", name: "lint" }));
  assert.equal(status, 200);
  assert.equal(server(body, "lint").disabled, false);
  assert.deepEqual((await readJson(overridePath)).mcpServers, {});
});

test("remove deletes from the file that defines the server", async () => {
  const { status, body } = await post({ action: "remove", scope: "global", name: "docs" });
  assert.equal(status, 200);
  assert.equal(server(body, "docs"), undefined);
  assert.deepEqual(Object.keys((await readJson(sharedPath)).mcpServers), ["lint"]);
});

test("a project server needs a trusted project, and its file is written only then", async () => {
  await write(projectPath, { mcpServers: { repo: { command: "node", args: ["server.js"] } } });
  let result = await post({ action: "disable", scope: "project", name: "repo", cwd });
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, "project-untrusted");

  store.set(cwd, true);
  result = await post({ action: "disable", scope: "project", name: "repo", cwd });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(server(result.body, "repo").scope, "project");
  assert.deepEqual((await readJson(join(cwd, ".pi", "mcp-adapter.json"))).mcpServers.repo, { disabled: true });
  assert.equal((await get(cwd)).body.servers.find((entry) => entry.name === "repo").disabled, true);
});

test("refusals are typed, and a change to a server the files no longer define is 409", async () => {
  assert.equal((await post({ action: "disable", scope: "global", name: "gone" })).body.reason, "server-missing");
  assert.equal((await post({ action: "arms", scope: "global", name: "lint" })).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ action: "disable", scope: "global", name: "lint" }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ action: "disable", scope: "global", name: "lint" }, { origin: "https://evil.example" })).body.reason, "request-denied");
  assert.equal((await get("/nowhere/at/all")).body.reason, "cwd-denied");
  assert.equal((await get("relative/dir")).body.reason, "cwd-invalid");

  // A comment a rewrite would drop is refused, not silently removed.
  await write(sharedPath, `${await readFile(sharedPath, "utf8")} // keep me\n`.replace("}\n // keep me\n", "} // keep me\n"));
  await write(sharedPath, '{ // keep me\n"mcpServers": {"lint": {"command": "npx"}}}\n');
  const refused = await post({ action: "remove", scope: "global", name: "lint" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "has-comments");
});
