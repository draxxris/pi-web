import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const builtins = new Set(builtinModules);

// npm's hoisting can make a transitive package look like a direct dependency.
// An isolated install (and a future change to the tree) need the declaration.
function imports(source, filename = "source.ts") {
  const result = [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function add(node, typeOnly = false) {
    if (!node || !ts.isStringLiteral(node)) return;
    const specifier = node.text;
    if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("node:") || builtins.has(specifier)) return;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    result.push({ name, typeOnly });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly = Boolean(clause?.isTypeOnly || (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every((e) => e.isTypeOnly)));
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expr) && expr.text === "require") ||
          (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "require" && expr.name.text === "resolve")) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // The demo is a separate package, not part of this dependency manifest.
      if (!entry.name.startsWith(".") && entry.name !== "node_modules" && !(dir === root && entry.name === "demo")) {
        yield* sourceFiles(join(dir, entry.name));
      }
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && entry.name !== "next-env.d.ts") {
      yield join(dir, entry.name);
    }
  }
}

test("dependency scanner recognizes static, dynamic, scoped and type-only imports", () => {
  assert.deepEqual(imports(`
    import type { Root } from "hast";
    import { type Node } from "mdast";
    export { value } from "@scope/pkg/subpath";
    type T = import("types-only").T;
    const x = import("refractor/all");
    const y = require("tool/subpath");
    require.resolve("other");
    import fs from "node:fs";
    import "./local";
    const ignored = "not-an-import";
  `), [
    { name: "hast", typeOnly: true }, { name: "mdast", typeOnly: true },
    { name: "@scope/pkg", typeOnly: false }, { name: "types-only", typeOnly: true },
    { name: "refractor", typeOnly: false }, { name: "tool", typeOnly: false },
    { name: "other", typeOnly: false },
  ]);
});

test("every literal package import is declared directly", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  const missing = [];
  for (const path of sourceFiles(root)) {
    for (const { name, typeOnly } of imports(readFileSync(path, "utf8"), path)) {
      const typesName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
      if (!declared[name] && !(typeOnly && declared[typesName])) missing.push(`${relative(root, path)}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `Undeclared imports:\n${missing.join("\n")}`);
});
