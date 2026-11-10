import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  jumpToMarkdownFragment,
  markdownAppUrlTransform,
  markdownPreviewRehypePlugins,
  markdownPreviewRemarkPlugins,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from "./markdown.ts";

// Both pipelines that render Markdown in the app: the chat one and the file
// preview one. The sanitizer that prefixes `id`s sits in both, so the matching
// fragment-link rule must hold in both.
const pipelines = [
  ["chat", markdownRemarkPlugins, markdownRehypePlugins],
  ["file preview", markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins],
];

function render(markdown, remarkPlugins, rehypePlugins) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins,
    rehypePlugins,
    urlTransform: markdownAppUrlTransform,
  }, markdown));
}

describe("fragment links follow the sanitizer's id prefix", () => {
  it("keeps a hand-written anchor pair consistent in chat and file previews", () => {
    for (const [name, remarkPlugins, rehypePlugins] of pipelines) {
      const html = render('<a id="s2"></a>\n\n[S2](#s2)', remarkPlugins, rehypePlugins);
      assert.ok(html.includes('id="user-content-s2"'), `${name}: ${html}`);
      assert.ok(html.includes('href="#user-content-s2"'), `${name}: ${html}`);
    }
  });

  it("rewrites the fragment of a raw-HTML anchor as well", () => {
    for (const [name, remarkPlugins, rehypePlugins] of pipelines) {
      const html = render('<a href="#s2">raw</a>', remarkPlugins, rehypePlugins);
      assert.ok(html.includes('href="#user-content-s2"'), `${name}: ${html}`);
    }
  });

  it("keeps footnote links reaching their elements", () => {
    // mdast-util-to-hast generates footnote ids and hrefs already carrying the
    // prefix, and sanitizing prefixes the id once more — an href left as
    // generated would strand every footnote link behind the doubled prefix.
    for (const [name, remarkPlugins, rehypePlugins] of pipelines) {
      const html = render("text[^1]\n\n[^1]: the note", remarkPlugins, rehypePlugins);
      const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
      assert.ok(hrefs.length >= 2, `${name}: expected footnote links, got ${html}`);
      for (const href of hrefs) {
        assert.ok(ids.has(href), `${name}: #${href} has no element in ${html}`);
      }
    }
  });

  it("gives file-preview headings the slug a generated report links to", () => {
    // A code audit report's summary table: `#ca1-…` names the finding's
    // heading, which GitHub slugs. The preview must resolve it the same way.
    const report = "| ID |\n| --- |\n| [CA1](#ca1-corpse-loot-item-slots) |\n\n### CA1: Corpse Loot Item Slots\n";
    const html = render(report, markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins);
    assert.ok(html.includes('href="#user-content-ca1-corpse-loot-item-slots"'), html);
    assert.ok(html.includes('data-heading-anchor="ca1-corpse-loot-item-slots"'), html);
    assert.doesNotMatch(html, /\sid="/, "a heading slug is a data attribute, never an id");
    // Chat keeps its headings anchorless: two messages repeating a heading
    // would share an id, and the store's blocks are not one document.
    const chat = render("### CA1: Corpse Loot Item Slots", markdownRemarkPlugins, markdownRehypePlugins);
    assert.doesNotMatch(chat, /data-heading-anchor/);
  });

  it("does not touch external fragments or a bare hash", () => {
    for (const [name, remarkPlugins, rehypePlugins] of pipelines) {
      const html = render("[ext](https://example.com/docs#section) and [top](#)", remarkPlugins, rehypePlugins);
      assert.ok(html.includes('href="https://example.com/docs#section"'), `${name}: ${html}`);
      assert.ok(html.includes('href="#"'), `${name}: ${html}`);
    }
  });
});

describe("jumpToMarkdownFragment", () => {
  globalThis.CSS ??= { escape: (value) => value.replace(/["\\]/g, "\\$&") };

  /**
   * A rendered document holding the given ids and `data-heading-anchor` slugs.
   * Every lookup is recorded, so a test sees what the click looked for.
   */
  function click(href, { ids = ["user-content-café"], headings = [], overrides = {} } = {}) {
    const calls = { prevented: false, selectors: [], scrolled: null, root: null };
    const target = { scrollIntoView: (options) => { calls.scrolled = options; } };
    const body = {
      querySelector: (query) => {
        calls.selectors.push(query);
        const id = /^\[id="(.*)"\], a\[name=".*"\]$/.exec(query);
        if (id) return ids.includes(id[1]) ? target : null;
        const anchor = /^\[data-heading-anchor="(.*)"\]$/.exec(query);
        return anchor && headings.includes(anchor[1]) ? target : null;
      },
      querySelectorAll: (query) => {
        calls.selectors.push(query);
        return headings.map((slug) => ({ getAttribute: () => slug, scrollIntoView: target.scrollIntoView }));
      },
    };
    jumpToMarkdownFragment({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: {
        getAttribute: (name) => (name === "href" ? href : null),
        closest: (selector) => {
          calls.root = selector;
          return body;
        },
      },
      preventDefault: () => { calls.prevented = true; },
      ...overrides,
    });
    return calls;
  }

  it("scrolls to the element within the link's own rendered document", () => {
    const calls = click("#user-content-caf%C3%A9");
    assert.equal(calls.prevented, true);
    assert.equal(calls.root, ".markdown-body");
    assert.deepEqual(calls.selectors, ['[id="user-content-café"], a[name="user-content-café"]']);
    assert.deepEqual(calls.scrolled, { block: "start" });
  });

  it("falls back to the heading a slug names behind the sanitizer's prefix", () => {
    const calls = click("#user-content-ca1-corpse-loot-item-slots", {
      ids: [],
      headings: ["ca1-corpse-loot-item-slots"],
    });
    assert.equal(calls.prevented, true);
    assert.deepEqual(calls.selectors, [
      '[id="user-content-ca1-corpse-loot-item-slots"], a[name="user-content-ca1-corpse-loot-item-slots"]',
      '[data-heading-anchor="ca1-corpse-loot-item-slots"]',
    ]);
    assert.deepEqual(calls.scrolled, { block: "start" });
  });

  it("squeezes hyphen runs so a generator's collapsed slug still lands", () => {
    // github-slugger keeps one hyphen per space ("Blasts / Telegraphs" is
    // "blasts--telegraphs"); a generator that collapses whitespace writes one.
    const calls = click("#user-content-ca16-ground-placed-aoe-delayed-blasts-telegraphs", {
      ids: [],
      headings: ["ca16-ground-placed-aoe-delayed-blasts--telegraphs"],
    });
    assert.deepEqual(calls.scrolled, { block: "start" });
  });

  it("leaves a fragment with no target unscrolled", () => {
    const calls = click("#user-content-missing", { ids: [], headings: [] });
    assert.equal(calls.prevented, true);
    assert.equal(calls.scrolled, null);
  });

  it("keeps a bare hash off the URL and leaves other links and modified clicks alone", () => {
    assert.deepEqual(click("#"), { prevented: true, selectors: [], scrolled: null, root: null });
    assert.equal(click("other.md").prevented, false);
    assert.equal(click("#x", { overrides: { metaKey: true } }).prevented, false);
    assert.equal(click("#x", { overrides: { button: 1 } }).prevented, false);
  });
});
