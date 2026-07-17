import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _private,
  countLines,
  formatIssue,
  formatMarkdown,
  parseBaselineRows,
  scanFileList,
  scopeForPath,
  withRawDeltas,
} from "./file-size-watchlist.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

test("scopeForPath excludes generated files, non-Aegis tests, and dashboard types", () => {
  assert.equal(scopeForPath("indexer-envio/.envio/types.d.ts"), null);
  assert.equal(
    scopeForPath("ui-dashboard/src/lib/__generated__/graphql.ts"),
    null,
  );
  assert.equal(scopeForPath("ui-dashboard/src/lib/types.ts"), null);
  assert.equal(
    scopeForPath("ui-dashboard/src/lib/__tests__/foo.test.ts"),
    null,
  );
  assert.equal(scopeForPath("indexer-envio/src/foo.spec.ts"), null);
  assert.equal(scopeForPath("aegis/src/query.service.spec.ts")?.label, "aegis");

  assert.equal(
    scopeForPath("ui-dashboard/src/lib/network-fetcher/fetch.ts")?.label,
    "dashboard",
  );
  assert.equal(
    scopeForPath("indexer-envio/src/handlers/liquity/troveManager.ts")?.label,
    "indexer",
  );
});

test("countLines tracks raw lines and rough non-comment lines", () => {
  const source = [
    "// comment",
    "",
    "const a = 1;",
    "/* block",
    " * body",
    " */",
    "const b = 2;",
  ].join("\n");

  assert.deepEqual(countLines(source), { raw: 7, rough: 2 });
  assert.deepEqual(countLines("const a = 1;\n"), { raw: 1, rough: 1 });
});

test("scanFileList reports package source files at raw or rough threshold", () => {
  const files = [
    "ui-dashboard/src/lib/raw-large.ts",
    "indexer-envio/src/rough-large.ts",
    "indexer-envio/.envio/types.d.ts",
  ];
  const rawLarge = Array.from({ length: 601 }, () => "// comment").join("\n");
  const roughLarge = Array.from({ length: 1000 }, (_, index) => {
    return `const value${index} = ${index};`;
  }).join("\n");
  const rows = scanFileList(files, (path) => {
    if (path.endsWith("raw-large.ts")) return rawLarge;
    if (path.endsWith("rough-large.ts")) return roughLarge;
    return "generated";
  });

  assert.deepEqual(
    rows.map((row) => [row.path, row.status]),
    [
      ["indexer-envio/src/rough-large.ts", "hard"],
      ["ui-dashboard/src/lib/raw-large.ts", "watch"],
    ],
  );
});

test("formatMarkdown and formatIssue point away from BACKLOG.md", () => {
  const rows = [
    {
      path: "ui-dashboard/src/lib/network-fetcher/fetch.ts",
      package: "dashboard",
      raw: 779,
      rough: 607,
      status: "soft",
      rawDelta: -533,
    },
  ];
  const markdown = formatMarkdown(rows, { generatedAt: "2026-07-03" });
  assert.match(
    markdown,
    /docs\/notes\/file-size-watch\.md|file-size-watchlist/,
  );
  assert.match(markdown, /\| 607 \| 779 \| -533 \| soft cap \|/);

  const issue = formatIssue(rows, { generatedAt: "2026-07-03" });
  assert.match(issue, /GitHub Issues or docs notes/);
  assert.doesNotMatch(issue, /Append.*BACKLOG\.md/);
});

test("baseline parsing supports docs notes and old backlog tables", () => {
  const baseline = [
    "| Raw | Rough | File | Action |",
    "| --: | ----: | ---- | ------ |",
    "| 759 | 520 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch |",
    "",
    "| Rough | Raw | Delta | Status | File |",
    "| ----: | --: | ----: | ------ | ---- |",
    "| 721 | 757 | -275 | soft cap | `indexer-envio/src/handlers/liquity/troveManager.ts` |",
    "",
    "| Lines | File | Δ since last report |",
    "| ----: | ---- | ------------------: |",
    "| 978 | integration-probes/src/adapters.ts | (new) |",
  ].join("\n");

  assert.deepEqual(
    [...parseBaselineRows(baseline).entries()],
    [
      ["ui-dashboard/src/lib/network-fetcher/fetch.ts", 759],
      ["indexer-envio/src/handlers/liquity/troveManager.ts", 757],
      ["integration-probes/src/adapters.ts", 978],
    ],
  );
});

test("json output honors --limit", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/file-size-watchlist.mjs", "--format", "json", "--limit", "1"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).rows.length, 1);
});

test("withRawDeltas marks new and changed files", () => {
  const rows = [
    { path: "existing.ts", raw: 120, rough: 100, status: "ok" },
    { path: "new.ts", raw: 50, rough: 50, status: "ok" },
  ];

  assert.deepEqual(
    withRawDeltas(rows, new Map([["existing.ts", 100]])).map((row) => [
      row.path,
      row.rawDelta,
    ]),
    [
      ["existing.ts", 20],
      ["new.ts", null],
    ],
  );
});

test("fail-on policy only blocks the requested severity", () => {
  assert.equal(_private.shouldFail([{ status: "watch" }], "soft"), false);
  assert.equal(_private.shouldFail([{ status: "soft" }], "soft"), true);
  assert.equal(_private.shouldFail([{ status: "soft" }], "hard"), false);
  assert.equal(_private.shouldFail([{ status: "hard" }], "hard"), true);
});
