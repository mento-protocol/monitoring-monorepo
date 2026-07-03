import assert from "node:assert/strict";
import { test } from "node:test";

import {
  _private,
  countLines,
  formatIssue,
  formatMarkdown,
  scanFileList,
  scopeForPath,
} from "./file-size-watchlist.mjs";

test("scopeForPath excludes generated files, tests, and dashboard types", () => {
  assert.equal(scopeForPath("indexer-envio/.envio/types.d.ts"), null);
  assert.equal(scopeForPath("ui-dashboard/src/lib/types.ts"), null);
  assert.equal(
    scopeForPath("ui-dashboard/src/lib/__tests__/foo.test.ts"),
    null,
  );
  assert.equal(scopeForPath("aegis/src/query.service.spec.ts"), null);

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
    },
  ];
  const markdown = formatMarkdown(rows, { generatedAt: "2026-07-03" });
  assert.match(
    markdown,
    /docs\/notes\/file-size-watch\.md|file-size-watchlist/,
  );
  assert.match(markdown, /\| 607 \| 779 \| soft cap \|/);

  const issue = formatIssue(rows, { generatedAt: "2026-07-03" });
  assert.match(issue, /GitHub Issues or docs notes/);
  assert.doesNotMatch(issue, /Append.*BACKLOG\.md/);
});

test("fail-on policy only blocks the requested severity", () => {
  assert.equal(_private.shouldFail([{ status: "watch" }], "soft"), false);
  assert.equal(_private.shouldFail([{ status: "soft" }], "soft"), true);
  assert.equal(_private.shouldFail([{ status: "soft" }], "hard"), false);
  assert.equal(_private.shouldFail([{ status: "hard" }], "hard"), true);
});
