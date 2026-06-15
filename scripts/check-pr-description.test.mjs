import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePrDescription } from "./check-pr-description.mjs";

function body(extra = "") {
  return `## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
${extra}`;
}

function assertPass(text, expected) {
  const result = validatePrDescription(text);
  assert.equal(result.ok, true, result.message);
  if (expected) assert.match(result.message, expected);
}

function assertFail(text, expected) {
  const result = validatePrDescription(text);
  assert.equal(result.ok, false, "expected validation to fail");
  assert.match(result.message, expected);
}

test("passes when Deferrals is omitted", () => {
  assertPass(body(), /no Deferrals section/);
});

test("passes with explicit None deferral item", () => {
  assertPass(
    body(`

## Deferrals

- None
`),
    /deferrals declared/,
  );
});

test("passes with explicit None deferral item with trailing period", () => {
  assertPass(
    body(`

## Deferrals

- None.
`),
    /deferrals declared/,
  );
});

test("passes with linked deferral issue item", () => {
  assertPass(
    body(`

## Deferrals

- #123 tracks the follow-up.
- https://github.com/mento-protocol/monitoring-monorepo/issues/456 tracks another.
`),
    /deferrals declared/,
  );
});

test("fails an empty body before heading checks", () => {
  assertFail("   \n", /PR description is empty/);
});

test("fails unfilled template placeholders", () => {
  assertFail(
    body(`

[Plain-English problem or user impact]
`),
    /unfilled template placeholders/,
  );
});

test("fails when the first sections are not The Problem then The Solution", () => {
  assertFail(
    `# Summary

${body()}`,
    /must START with '## The Problem' then '## The Solution'/,
  );
});

test("allows HTML comments before the opening heading", () => {
  assertPass(`<!-- markdownlint-disable MD041 -->

${body()}`);
});

test("preserves content after a closing HTML comment marker", () => {
  assertPass(`<!--
template comment
-->## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`);
});

test("does not allow a leading code fence before the opening heading", () => {
  assertFail(
    `\`\`\`md
example
\`\`\`

${body()}`,
    /must START with '## The Problem' then '## The Solution'/,
  );
});

test("fails an unclosed fence before Deferrals instead of hiding the tail", () => {
  assertFail(
    body(`

## Details

\`\`\`md
example

## Deferrals

- Do this later.
`),
    /unclosed fenced code block/,
  );
});

test("ignores fenced and commented Deferrals examples", () => {
  assertPass(
    body(`

## Details

\`\`\`md
## Deferrals
- later
\`\`\`

<!--
## Deferrals
- later
-->
`),
    /no Deferrals section/,
  );
});

test("fails a present but empty Deferrals section", () => {
  assertFail(
    body(`

## Deferrals

## Validation

- node scripts/check-pr-description.test.mjs
`),
    /must list its content as items/,
  );
});

test("fails unlinked Deferrals item prose", () => {
  assertFail(
    body(`

## Deferrals

- Do this later.
`),
    /Missing issue reference/,
  );
});

test("fails near-miss Deferrals headings", () => {
  for (const heading of [
    "### Deferrals",
    "## Deferrals:",
    "##Deferrals",
    "## deferrals",
  ]) {
    assertFail(
      body(`

${heading}

- #123 follow-up
`),
      /isn't exactly '## Deferrals'/,
    );
  }
});
