import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

// The padlock (LockToggle) imports a CSS module: its class names stand for themselves.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { AgentMiniStrip } = await jiti.import("./AgentMiniStrip.tsx");

function session(id, created, relation) {
  return { path: `/tmp/${id}.jsonl`, id, cwd: "/tmp", created, modified: created, messageCount: 1, firstMessage: id, ...(relation ? { relation } : {}) };
}

const root = session("main", "2026-01-01T00:00:00.000Z");
const members = [
  session("a", "2026-01-02T00:00:00.000Z", { kind: "subagent", parentSessionId: "main", profile: "explore", description: "Inspect", status: "completed" }),
  session("b", "2026-01-03T00:00:00.000Z", { kind: "subagent", parentSessionId: "main", profile: "plan", description: "Plan", status: "running" }),
  session("s", "2026-01-04T00:00:00.000Z", { kind: "side", parentSessionId: "main" }),
];

function render(selectedSessionId, locked = false, customMembers = members, allMembers = undefined) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(AgentMiniStrip, {
    rootSession: root, members: customMembers, allMembers, selectedSessionId, runningSessionIds: new Set(["b", "s2"]), onSelectSession() {}, locked, onToggleLock() {},
  })));
}

test("the Main agent chip sits outside the scrolling members, and only the current chip is a Tab stop", () => {
  const html = render("b");
  assert.match(html, /^<div role="toolbar" aria-label="Agents in this session"/);
  // Main agent comes before the scroller; the members are inside it.
  const scroller = html.indexOf('class="tabbar-scroll"');
  assert.ok(html.indexOf("Main agent") < scroller);
  assert.ok(html.indexOf(">Inspect<") > scroller && html.indexOf(">Side chat 1<") > scroller);

  const buttons = [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 5);
  assert.deepEqual(buttons.map((tag) => /tabindex="0"/.test(tag)), [false, false, true, false, false]);
  assert.deepEqual(buttons.map((tag) => /aria-current="true"/.test(tag)), [false, false, true, false, false]);
  assert.match(buttons[0], /title="Back to the main agent"/);
  // Colours are classes, so hover can change them.
  assert.ok(buttons.every((tag) => !/style="[^"]*(?:^|;)color:/.test(tag)));
  assert.match(buttons[1], /class="[^"]*text-text-muted[^"]*hover:text-text/);
});

test("the padlock sits after the scrolling members and says whether the strip is locked", () => {
  const unlocked = [...render("b").matchAll(/<button[^>]*>/g)].map(([tag]) => tag).at(-1);
  assert.match(unlocked, /aria-label="Lock: show this strip on the main agent too"/);
  assert.match(unlocked, /aria-pressed="false"/);
  assert.match(unlocked, /title="Lock: show this strip on the main agent too"/);

  const locked = [...render("b", true).matchAll(/<button[^>]*>/g)].map(([tag]) => tag).at(-1);
  assert.match(locked, /aria-pressed="true"/);
  assert.match(locked, /title="Unlock: show this strip only in a subagent or side chat"/);
  assert.ok(render("b").lastIndexOf("<button") > render("b").indexOf('class="tabbar-scroll"'));
});

test("locked on the main agent, the Main agent chip is the current one", () => {
  const buttons = [...render("main", true).matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
  assert.deepEqual(buttons.map((tag) => /aria-current="true"/.test(tag)), [true, false, false, false, false]);
  assert.deepEqual(buttons.map((tag) => /tabindex="0"/.test(tag)), [true, false, false, false, false]);
  assert.match(buttons[0], /title="Main agent"/);
});

test("viewing a finished subagent with no active members keeps Main agent as the Tab stop", () => {
  const html = render("finished", false, []);
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((tag) => /tabindex="0"/.test(tag)), [true, false]);
  assert.deepEqual(buttons.map((tag) => /aria-current="true"/.test(tag)), [false, false]);
  assert.match(buttons[0], /title="Back to the main agent"/);
});

test("side chat numbering preserves full family order when only an active side chat is shown", () => {
  const s1 = session("s1", "2026-01-02T00:00:00.000Z", { kind: "side", parentSessionId: "main" });
  const s2 = session("s2", "2026-01-03T00:00:00.000Z", { kind: "side", parentSessionId: "main" });
  const html = render("s2", false, [s2], [s1, s2]);
  assert.ok(html.includes(">Side chat 2<"));
  assert.ok(!html.includes(">Side chat 1<"));
});

test("a queued subagent shows its Queued status without a running spinner", () => {
  const queued = session("q", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Waiting", status: "queued",
  });
  const html = render("q", false, [queued]);
  assert.match(html, /title="Waiting · explore · Queued"/);
  assert.doesNotMatch(html, /animate-spin/);
});
