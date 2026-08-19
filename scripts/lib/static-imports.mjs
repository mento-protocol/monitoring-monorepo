/**
 * "What does this ES module statically import?", answered by V8's own parser.
 *
 * The single source of that answer for the Sentry-suite checker AND the
 * sentry-suite gate (issue #1779, ADR 0062). Both used to ask it with a regex,
 * and each regex produced its own review finding:
 *
 *   - unanchored, it counted `import` inside a string literal (a test file
 *     embedding fixture source pulled non-existent paths into the watch set);
 *   - line-anchored to fix that, it stopped matching ordinary MULTILINE imports,
 *     so three implementation modules dropped out of the watch set entirely and
 *     an earlier suite could rewrite a later suite's implementation unnoticed;
 *   - either way it matched `import("…")`, so an unreachable dynamic import
 *     satisfied a proof that the module really loads another one.
 *
 * Trading one regex failure for another means the regex is the wrong tool.
 * `vm.SourceTextModule(...).dependencySpecifiers` is the module record's own
 * dependency list: nothing is executed and no text is matched, so a
 * commented-out import, an import inside a string or template literal, and a
 * dynamic `import()` (reached or not) are all absent — correctly — while a
 * multiline `import { a,\n b } from "./x.mjs"`, an `export … from`, and an
 * `export * from` are all present.
 *
 * Dependency-free (node builtins only): the gate's `sentry-suites` CI job runs
 * with no `pnpm install`, so everything it loads must be too.
 */

import { execFileSync } from "node:child_process";

/**
 * Runs in a child because `vm.SourceTextModule` needs `--experimental-vm-modules`,
 * which the parent processes do not set. Paths arrive as JSON on stdin rather
 * than in argv so a large closure cannot hit ARG_MAX, and every path is answered
 * individually — one unreadable file must not blind the caller to the rest.
 */
const CHILD_PROGRAM = `
const vm = require("node:vm");
const fs = require("node:fs");
const paths = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
for (const path of paths) {
  let source;
  try {
    // Node strips the shebang when it loads a file; vm.SourceTextModule does not.
    source = fs.readFileSync(path, "utf8").replace(/^#![^\\n]*/, "");
  } catch (err) {
    out[path] = { missing: true, error: String((err && err.message) || err) };
    continue;
  }
  try {
    out[path] = {
      specifiers: new vm.SourceTextModule(source, { identifier: path }).dependencySpecifiers,
    };
  } catch (err) {
    out[path] = { missing: false, error: String((err && err.message) || err) };
  }
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * Parse many modules in ONE child process.
 *
 * Batching is what keeps this affordable: a spawn costs ~28ms, so asking V8
 * about the gate's ~45-file watch-set closure one file at a time would add
 * ~1.2s to a ~3.5s gate. A breadth-first closure that parses each frontier in a
 * single child does the same work in a handful of spawns.
 *
 * @param {string[]} paths absolute paths
 * @returns {Map<string, { specifiers: string[] } | { error: string, missing: boolean }>}
 *   keyed by the exact strings passed in
 */
export function staticImportsOf(paths) {
  if (paths.length === 0) return new Map();
  // The gate's own latch, applied to the one child this module spawns: an
  // ambient NODE_OPTIONS=--import=…exit(0) would empty stdout, and while that
  // already fails closed at JSON.parse, refusing to inherit it is cheaper than
  // reasoning about it.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const out = execFileSync(
    process.execPath,
    ["--experimental-vm-modules", "--no-warnings", "-e", CHILD_PROGRAM],
    {
      encoding: "utf8",
      env,
      input: JSON.stringify(paths),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return new Map(Object.entries(JSON.parse(out)));
}

/**
 * The static import specifiers of one module. Throws when the file cannot be
 * read or cannot be parsed — a caller asking "does this module import that
 * one?" must not read a parse failure as "no".
 *
 * @param {string} path absolute path
 * @returns {string[]}
 */
export function staticImports(path) {
  const result = staticImportsOf([path]).get(path);
  if (!result || result.error !== undefined) {
    throw new Error(
      `cannot read the static imports of ${path}: ${result?.error ?? "no result"}`,
    );
  }
  return result.specifiers;
}
