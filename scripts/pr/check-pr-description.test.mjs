import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPrBody } from "../sentry/autofix/sentry-autofix-finalize.mjs";
import { validatePrDescription } from "./check-pr-description.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const relativeScriptPath = relative(
  repoRoot,
  fileURLToPath(new URL("./check-pr-description.mjs", import.meta.url)),
);

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

test("accepts the deterministic Sentry autofix PR body", () => {
  assertPass(buildPrBody({ shortId: "APP-MENTO-ORG-2S", queueIssue: 1278 }));
});

test("required workflow installs trusted validator dependencies before validation", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/pr-description.yml", import.meta.url),
    "utf8",
  );
  const install = workflow.indexOf("Install trusted validator dependencies");
  const validate = workflow.indexOf("Validate PR description");
  assert.notEqual(install, -1, "trusted dependency install step is present");
  assert.notEqual(validate, -1, "validator step is present");
  assert.ok(install < validate, "trusted dependencies install first");
  const installStep = workflow.slice(install, validate);
  assert.match(
    installStep,
    /working-directory: trusted-base[\s\S]*pnpm --filter @mento-protocol\/monitoring-monorepo install\s+--frozen-lockfile --ignore-scripts/,
  );
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

test("fails a comment-only Problem section", () => {
  assertFail(
    `## The Problem

<!-- Explain the old behavior and effect. -->

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("fails a blank Solution section", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails opening sections left as template comments", () => {
  assertFail(
    `## The Problem

<!--
Explain what the system did before and its concrete effect.
-->

## The Solution

<!--
Explain the new behavior and why it helps.
-->

## Validation

- Tests passed.
`,
    /Problem.*must contain visible content/,
  );
});

test("allows inline HTML comments beside visible Markdown", () => {
  assertPass(`## The Problem

Visible problem prose. <!-- template note -->

## The Solution

<!-- prefix --> Visible solution prose.
`);
});

test("does not count visible text inside raw HTML", () => {
  assertFail(
    `## The Problem

<p>The old behavior failed.</p>

## The Solution

<p>The new behavior avoids that failure.</p>
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count a Markdown paragraph that contains raw HTML", () => {
  assertFail(
    `## The Problem

The old path failed for operators.<br>

## The Solution

- The new path avoids that failure.
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count a paragraph with raw HTML nested in Markdown", () => {
  assertFail(
    `## The Problem

Visible text *<span>raw</span>*

## The Solution

- The new path avoids that failure.
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count tag-only raw HTML as explanatory content", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

<br>
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count an HTML attribute delimiter as visible text", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

<span title=">"></span>
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count text inside non-rendering HTML elements", () => {
  for (const html of [
    "<script>hidden text</script>",
    "<style>hidden text</style>",
    "<template><p>hidden text</p></template>",
  ]) {
    assertFail(
      `## The Problem

- Reviewers need a clear problem statement.

## The Solution

${html}
`,
      /Solution.*must contain visible content/,
    );
  }
});

test("does not count default-ignorable Unicode as explanatory content", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

${"\u200B"}
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count invisible HTML character references", () => {
  for (const html of ["<p>&nbsp;</p>", "<p>&#8203;</p>"]) {
    assertFail(
      `## The Problem

- Reviewers need a clear problem statement.

## The Solution

${html}
`,
      /Solution.*must contain visible content/,
    );
  }
});

test("fails a Problem section containing only a link-reference definition", () => {
  assertFail(
    `## The Problem

[comment]: # (placeholder)

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("fails a Solution section containing only a link-reference definition", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: # (placeholder)

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a Problem section containing only a multiline link-reference definition", () => {
  assertFail(
    `## The Problem

[comment]:
  /placeholder
  "template note"

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("fails an escaped-label link-reference definition in Solution", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment\\]]: /placeholder "template note"

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a multiline link-reference label in Solution", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[template
note]: /placeholder

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a blockquote containing only a link-reference definition", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

> [comment]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("accepts the CommonMark maximum label length as a hidden definition", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[${"a".repeat(999)}]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("keeps an over-limit link-reference label as visible content", () => {
  assertPass(`## The Problem

- Reviewers need a clear problem statement.

## The Solution

[${"a".repeat(1000)}]: /placeholder
`);
});

test("counts a backslash as visible link-label content", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[\\ ]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a link-reference definition with its title on the next line", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /placeholder
  "template note"

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a link-reference definition with a multiline inline title", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /placeholder "template
  note"

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a link-reference definition with a multiline title on the next line", () => {
  assertFail(
    `## The Problem

[comment]: /placeholder
  "template
  note"

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("resets title escaping at a physical line boundary", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /placeholder "template\\
"

## Validation

- Tests passed.
`,
    /Solution.*must contain visible content/,
  );
});

test("keeps a malformed raw link destination as visible content", () => {
  assertPass(`## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /unbalanced(destination "template note"
`);
});

test("strips a balanced raw link destination", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /balanced(destination) "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count a malformed definition that contains raw HTML", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: </placeholder>"template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("strips an angle destination with whitespace before its title", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: </placeholder> "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count tab-indented code as explanatory content", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

\t[comment]: /placeholder "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count an indented H2 section as Solution content", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

  ## Details

- This belongs to Details.
`,
    /Solution.*must contain visible content/,
  );
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

test("does not close a backtick fence with a tilde fence", () => {
  assertFail(
    body(`

## Details

\`\`\`\`md
example
~~~~
`),
    /unclosed fenced code block/,
  );
});

test("does not open a fenced block after a leading tab", () => {
  assertPass(
    body(`

## Details

\t\`\`\`md
visible indented code
`),
  );
});

test("does not close a fence with a shorter run of the same marker", () => {
  assertFail(
    body(`

## Details

~~~~
example
~~~
`),
    /unclosed fenced code block/,
  );
});

test("closes a fence with a longer run of the same marker", () => {
  assertPass(
    body(`

## Details

~~~md
example
~~~~
`),
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

test("fails unlinked items in later Deferrals sections", () => {
  assertFail(
    body(`

## Deferrals

- None

## Validation

- node scripts/check-pr-description.test.mjs

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

test("CLI guard runs validation when invoked with a relative script path", () => {
  let error;
  try {
    execFileSync(process.execPath, [relativeScriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "# Summary\n" },
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected CLI validation to fail");
  assert.match(error.stdout, /must START with '## The Problem'/);
});

test("CLI guard prints success when invoked with a relative script path", () => {
  const output = execFileSync(process.execPath, [relativeScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PR_BODY: body() },
  });
  assert.match(output, /PR description OK/);
});
