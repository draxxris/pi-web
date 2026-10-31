import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./useTopBarButtons.ts", import.meta.url), "utf8");
const script = new Script(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText);
const KEY = "pi-web:top-bar-buttons";
const BOTH = { history: true, debug: true };
// The module under test runs in another realm, where a plain object literal is not deepStrictEqual
// to this one; every read is copied into a same-realm object first.
const shown = (value) => ({ ...value });

// A fresh module per fixture: the store caches the choice at module level. The
// stand-in useSyncExternalStore subscribes once, as a mounted component does,
// and renders the server snapshot where there is no window.
function fixture({ initial = {}, blocked = false, server = false } = {}) {
  const stored = new Map(Object.entries(initial));
  const events = new Map();
  let unsubscribe = null;
  let notifications = 0;
  const storage = {
    getItem(key) { if (blocked) throw new Error("blocked"); return stored.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error("blocked"); stored.set(key, value); },
  };
  const exports = {};
  script.runInNewContext({
    exports,
    require(id) {
      if (id !== "react") throw new Error(`Unexpected import ${id}`);
      return {
        useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
          if (server) return getServerSnapshot();
          unsubscribe ??= subscribe(() => notifications++);
          return getSnapshot();
        },
      };
    },
    ...(!server && {
      window: {
        localStorage: storage,
        addEventListener(type, listener) { assert.equal(events.has(type), false); events.set(type, listener); },
        removeEventListener(type, listener) { assert.equal(events.get(type), listener); events.delete(type); },
      },
    }),
  });
  return {
    ...exports,
    stored,
    events,
    get notifications() { return notifications; },
    unmount() { unsubscribe?.(); unsubscribe = null; },
  };
}

test("only a stored false hides a button; anything unreadable shows both", () => {
  const store = fixture();
  for (const raw of [null, "", "{", "[]", "true", "\"debug\"", "{}"]) {
    assert.deepEqual(shown(store.parseTopBarButtons(raw)), BOTH, String(raw));
  }
  assert.deepEqual(shown(store.parseTopBarButtons("{\"history\":false}")), { history: false, debug: true });
  assert.deepEqual(shown(store.parseTopBarButtons("{\"debug\":false}")), { history: true, debug: false });
  assert.deepEqual(shown(store.parseTopBarButtons("{\"history\":0,\"debug\":null}")), BOTH, "only false hides");
  assert.equal(store.TOP_BAR_BUTTONS_STORAGE_KEY, KEY);
  assert.deepEqual(shown(store.TOP_BAR_BUTTONS_DEFAULT), BOTH);
});

test("the server renders both buttons without touching browser APIs", () => {
  const store = fixture({ server: true, initial: { [KEY]: "{\"history\":false}" } });
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH);
});

test("a saved choice is restored, and a new one is saved and announced", () => {
  const store = fixture({ initial: { [KEY]: "{\"debug\":false}" } });
  assert.deepEqual(shown(store.useTopBarButtons()), { history: true, debug: false });
  store.setTopBarButton("history", false);
  assert.deepEqual(shown(store.useTopBarButtons()), { history: false, debug: false });
  assert.equal(store.stored.get(KEY), "{\"history\":false,\"debug\":false}");
  assert.equal(store.notifications, 1);
  store.setTopBarButton("history", false);
  assert.equal(store.notifications, 1, "the same choice again changes nothing");
});

test("another tab's choice for this key, or a cleared storage, is followed", () => {
  const store = fixture();
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH);
  const onStorage = store.events.get("storage");
  store.stored.set(KEY, "{\"history\":false}");
  onStorage({ key: "pi-web:sidebar-tab" });
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH, "another key is not this choice");
  assert.equal(store.notifications, 0);
  onStorage({ key: KEY });
  assert.deepEqual(shown(store.useTopBarButtons()), { history: false, debug: true });
  assert.equal(store.notifications, 1);
  store.stored.clear();
  onStorage({ key: null });
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH);
  assert.equal(store.notifications, 2);
  store.unmount();
  assert.equal(store.events.size, 0, "the last consumer stops listening");
});

test("a choice made while nobody listened is read again by the next consumer", () => {
  const store = fixture();
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH);
  store.unmount();
  store.stored.set(KEY, "{\"debug\":false}");
  assert.deepEqual(shown(store.useTopBarButtons()), { history: true, debug: false });
});

test("blocked storage leaves both buttons, and a choice still applies for the page", () => {
  const store = fixture({ blocked: true });
  assert.deepEqual(shown(store.useTopBarButtons()), BOTH);
  store.setTopBarButton("debug", false);
  assert.deepEqual(shown(store.useTopBarButtons()), { history: true, debug: false });
  assert.equal(store.notifications, 1);
});
