import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Regression guard for Phase 1 P1-05: no private address-label data may reach
// an unauth-reachable server-rendered payload (HTML, __NEXT_DATA__, RSC flight
// chunks). We can't render the app in a unit test, so we enforce the class of
// regression at the import-graph level:
//
//   1. The Redis-backed module `@/lib/address-labels` only imports label data
//      at runtime from server-only contexts (API route handlers). A client or
//      shared component that imports its *runtime* exports would pull Redis
//      into the browser bundle and — worse — invite somebody to server-render
//      labels into page HTML.
//   2. The label React context (`AddressLabelsProvider`) must stay `"use client"`
//      so labels are fetched after hydration, never embedded into RSC output.
//   3. `app/layout.tsx` must not import runtime values from the Redis module or
//      pass label data into any provider prop.
//
// Update this allowlist deliberately. Any change must be reviewed with
// "does this leak private labels into an unauth-reachable payload?" in mind.

const REPO_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const RUNTIME_IMPORT_ALLOWLIST = new Set<string>([
  // Server-only API route handlers: expected to import Redis-backed helpers.
  "src/app/api/address-labels/route.ts",
  "src/app/api/address-labels/backup/route.ts",
  "src/app/api/address-labels/export/route.ts",
  "src/app/api/address-labels/import/route.ts",
  // Self-references / tests.
  "src/lib/address-labels.ts",
]);

/** Recursively walks `dir` and yields source file paths under `src/`. */
function* walkSource(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      yield* walkSource(p);
      continue;
    }
    // Exclude __tests__ directories from the import-graph check — tests are
    // free to reach Redis helpers directly to assert behavior.
    if (/[\\/]__tests__[\\/]/.test(p)) continue;
    if (/\.test\.(ts|tsx)$/.test(p)) continue;
    if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

function listSrcFiles(): string[] {
  return [...walkSource(SRC_ROOT)];
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).replaceAll("\\", "/");
}

// Canonical absolute path of the Redis-backed label module (no extension).
// Any runtime import that resolves here — via the `@/` alias, a relative
// specifier, or `import()` — must be treated the same way.
const TARGET_MODULE_ABS = join(SRC_ROOT, "lib", "address-labels");

// Returns true if `specifier`, interpreted from `importerDir`, resolves to
// the label module. Matches:
//   - the `@/lib/address-labels` alias form (with or without `.ts`/`.tsx`)
//   - relative specifiers like `../../lib/address-labels` that resolve to
//     the same absolute path
// Bare specifiers pointing at other packages are ignored.
function refersToLabelModule(specifier: string, importerDir: string): boolean {
  const stripExt = (p: string) => p.replace(/\.(ts|tsx)$/, "");
  if (specifier.startsWith("@/")) {
    return stripExt(specifier) === "@/lib/address-labels";
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const absolute = stripExt(resolve(importerDir, specifier));
    return absolute === TARGET_MODULE_ABS;
  }
  return false;
}

// Count references to the Redis-backed label module that evaluate it at
// runtime in the importing file. Covers four syntactic shapes:
//   - `import … from "…"`    (named/default static import)
//   - `import "…"`            (side-effect import)
//   - `export … from "…"`    (re-export — re-binds values)
//   - `import("…")`           (dynamic import)
// Excludes `import type` / `export type` forms, which are erased at compile
// time and cannot ship runtime values (no Redis client, no label data) to
// the browser. All four shapes must be checked together; otherwise dropping
// the `from` clause, using a re-export, or switching to `import()` would
// silently bypass the guard. Specifiers are resolved via
// `refersToLabelModule` so an attacker can't dodge the alias literal by
// writing `../../lib/address-labels` or dynamically importing the module.
function countRuntimeRefs(content: string, filePath: string): number {
  const importerDir = dirname(filePath);
  const patterns: RegExp[] = [
    /^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm,
    /^import\s+["']([^"']+)["']/gm,
    /^export\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  let count = 0;
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (refersToLabelModule(match[1], importerDir)) count += 1;
    }
  }
  return count;
}

describe("P1-05 — RSC label-leak regression guard", () => {
  it("only API route handlers import runtime values from @/lib/address-labels", () => {
    const offenders: string[] = [];

    for (const file of listSrcFiles()) {
      const content = readFileSync(file, "utf8");

      if (countRuntimeRefs(content, file) === 0) continue;
      if (RUNTIME_IMPORT_ALLOWLIST.has(rel(file))) continue;

      offenders.push(rel(file));
    }

    expect(
      offenders,
      `Unexpected runtime import of @/lib/address-labels from:\n  ${offenders.join(
        "\n  ",
      )}\n\n` +
        `This pulls the Redis-backed label module into a non-API context. If ` +
        `this file is a server component or server action that needs labels ` +
        `on render, you are serializing private labels into unauth-reachable ` +
        `output and must stop. If this is genuinely a new server-only caller ` +
        `(e.g., a new API route), add it to RUNTIME_IMPORT_ALLOWLIST and have ` +
        `a reviewer confirm the auth gate on it.`,
    ).toEqual([]);
  });

  it("AddressLabelsProvider stays a client component", () => {
    const providerPath = join(
      SRC_ROOT,
      "components",
      "address-labels-provider.tsx",
    );
    const content = readFileSync(providerPath, "utf8");
    const firstNonEmptyLine = content
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();

    expect(
      firstNonEmptyLine,
      `AddressLabelsProvider must begin with "use client". If you drop the ` +
        `directive, it becomes a server component and every private label in ` +
        `Redis will be serialized into the RSC payload on every render.`,
    ).toBe('"use client";');
  });

  it("root layout does not import runtime values from @/lib/address-labels", () => {
    const layoutPath = join(SRC_ROOT, "app", "layout.tsx");
    const content = readFileSync(layoutPath, "utf8");

    expect(
      countRuntimeRefs(content, layoutPath),
      `app/layout.tsx is a server component. A runtime import of ` +
        `@/lib/address-labels would pull Redis in at the top of the tree and ` +
        `tempt someone to render labels into RSC. Keep labels behind the ` +
        `client-side SWR fetch in AddressLabelsProvider.`,
    ).toBe(0);
  });

  it("tag-suggestions only imports types from @/lib/address-labels", () => {
    const tagPath = join(SRC_ROOT, "lib", "tag-suggestions.ts");
    const content = readFileSync(tagPath, "utf8");

    expect(
      countRuntimeRefs(content, tagPath),
      `tag-suggestions.ts is consumed by the address-label-editor client ` +
        `component; any runtime import here reaches the browser bundle.`,
    ).toBe(0);
  });

  // Self-test the detector itself. If these regress, the first (full-tree)
  // test above stops protecting the real attack surface — a refactor that
  // switches to a relative or dynamic import would slip past it silently.
  describe("countRuntimeRefs detector", () => {
    const fakeFile = join(SRC_ROOT, "components", "fake.ts");

    it.each([
      ["alias named", 'import { x } from "@/lib/address-labels";'],
      ["alias side-effect", 'import "@/lib/address-labels";'],
      ["alias re-export", 'export { x } from "@/lib/address-labels";'],
      ["alias star re-export", 'export * from "@/lib/address-labels";'],
      ["alias dynamic", 'const m = await import("@/lib/address-labels");'],
      [
        "alias with .ts extension",
        'import { x } from "@/lib/address-labels.ts";',
      ],
      ["relative named", 'import { x } from "../lib/address-labels";'],
      ["relative dynamic", 'const m = await import("../lib/address-labels");'],
    ])("detects %s", (_label, src) => {
      expect(countRuntimeRefs(src, fakeFile)).toBe(1);
    });

    it.each([
      [
        "alias type-only import",
        'import type { X } from "@/lib/address-labels";',
      ],
      [
        "alias type-only re-export",
        'export type { X } from "@/lib/address-labels";',
      ],
      ["unrelated bare module", 'import React from "react";'],
      ["unrelated alias", 'import { y } from "@/lib/address-labels-shared";'],
      ["unrelated relative", 'import { y } from "../lib/other-module";'],
    ])("ignores %s", (_label, src) => {
      expect(countRuntimeRefs(src, fakeFile)).toBe(0);
    });
  });
});
