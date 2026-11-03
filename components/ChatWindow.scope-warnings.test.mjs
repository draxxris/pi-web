import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// An `enabledModels` pattern that matches nothing is worth naming once, on the
// new-session composer where the scope is picked. Left on always, the warning
// outlived that screen and sat above every reply of the session it warned about.
test("model scope warnings are shown only on the new-session composer", async () => {
  for (const path of ["../components/ChatWindow.tsx", "../demo/components/ChatWindow.tsx"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const prop = source.match(/^\s*modelScopeWarnings=\{(.*)\}$/m);
    assert.ok(prop, `expected the modelScopeWarnings prop in ${path}`);
    assert.equal(
      prop[1].trim(),
      "isEmptyNew ? modelScopeWarnings : undefined",
      `${path}: gate modelScopeWarnings on isEmptyNew, the new-session screen`,
    );
    // …and the gate has to mean what the comment says.
    assert.match(source, /const isEmptyNew = isNew && messages\.length === 0/, path);
  }
});
