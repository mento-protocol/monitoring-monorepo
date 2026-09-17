import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderPublicationBody } from "../review/review-eval-publication.mjs";
import { validatePrDescription } from "./check-pr-description.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const relativeScriptPath = relative(
  repoRoot,
  fileURLToPath(new URL("./check-pr-description.mjs", import.meta.url)),
);

function body(extra = "") {
  return `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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

function filler(words) {
  return Array.from({ length: words }, () => "word").join(" ");
}

// The three headings contribute five counted words: "tl;dr", "The", "Problem",
// "The", "Solution". Everything else in this body is filler, so the total is
// exact.
function sizedBody({ tldrWords, problemWords, solutionWords, extra = "" }) {
  return `## tl;dr

${filler(tldrWords)}

## The Problem

${filler(problemWords)}

## The Solution

${filler(solutionWords)}
${extra}`;
}

test("fails a body with no tl;dr section", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`,
    /must START with '## tl;dr'/,
  );
});

test("fails a tl;dr that is not the first section", () => {
  assertFail(
    `## The Problem

- Reviewers need a clear problem statement.

## tl;dr

The check now wants a plain summary first.

## The Solution

- This explains the approach.
`,
    /must START with '## tl;dr'/,
  );
});

test("rejects an H3 tl;dr near-miss as the opening heading", () => {
  assertFail(
    `### tl;dr

The check now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`,
    /must START with '## tl;dr'/,
  );
});

test("fails the unfilled tl;dr placeholder", () => {
  assertFail(
    `## tl;dr

[Two to four plain sentences, about 60 words.]

## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`,
    /unfilled template placeholders/,
  );
});

test("fails a tl;dr section left as a template comment", () => {
  assertFail(
    `## tl;dr

<!-- Summarize the change in plain words. -->

## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`,
    /'## tl;dr' section must contain visible content/,
  );
});

test("fails a tl;dr over the word limit", () => {
  assertFail(
    sizedBody({ tldrWords: 81, problemWords: 5, solutionWords: 5 }),
    /'## tl;dr' section is 81 words; the limit is 80/,
  );
});

test("passes a tl;dr at the word limit", () => {
  assertPass(sizedBody({ tldrWords: 80, problemWords: 5, solutionWords: 5 }));
});

test("passes an authored body at the word ceiling", () => {
  assertPass(
    sizedBody({ tldrWords: 20, problemWords: 100, solutionWords: 275 }),
  );
});

test("fails an authored body over the word ceiling", () => {
  assertFail(
    sizedBody({ tldrWords: 20, problemWords: 100, solutionWords: 276 }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("counts prose between inline-code comment delimiters", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: "\n`<!--` overflow `-->`",
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("excludes the template checklist from the word count", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: `
## Checklist

- [x] ${filler(60)}
`,
    }),
  );
});

test("excludes a bot-appended Summary by section from the word count", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: `
## Summary by CodeRabbit

- ${filler(60)}
`,
    }),
  );
});

test("counts prose parked under a Checklist heading", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: `
## Checklist

${filler(60)}
`,
    }),
    /authored PR description is 460 words; the ceiling is 400/,
  );
});

test("does not count punctuation entities as words", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<p>${"&mdash; &hellip; &rsquo; ".repeat(20)}</p>
`,
    }),
  );
});

// Reference names are case-sensitive, so the capitalized pair must resolve on
// its own key instead of falling through to the counting placeholder.
test("decodes capitalized punctuation entities on their own names", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<p>${"&Dagger; &Prime; &dagger; &prime; ".repeat(20)}</p>
`,
    }),
  );
});

// A zero-width reference renders as nothing, so it joins the letters around it.
// This body is exactly at the ceiling: decoding `&shy;` to a space instead would
// split each hyphenated word in two and push it to 402.
test("does not break a word at a zero-width entity", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 273,
      extra: `
<p>inter&shy;national inter&zwnj;national</p>
`,
    }),
  );
});

test("still separates words at a rendered space entity", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 273,
      extra: `
<p>inter&nbsp;national inter&thinsp;national</p>
`,
    }),
    /authored PR description is 402 words; the ceiling is 400/,
  );
});

test("decodes named whitespace entities inside raw HTML", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: "\n<p>one&Tab;two</p>",
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("does not count named punctuation entities inside raw HTML", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: "\n<p>&comma;</p>",
    }),
  );
});

test("counts Markdown definitions displayed literally inside raw HTML", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: "\n<p>[label]: /visible</p>",
    }),
    /authored PR description is 402 words; the ceiling is 400/,
  );
});

test("counts inline Markdown syntax displayed literally inside raw HTML", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: '\n<p>[visible](url "title words")</p>',
    }),
    /authored PR description is 402 words; the ceiling is 400/,
  );
});

test("counts prose written as unlisted named character references", () => {
  const encoded = "&Aacute;&Aacute;&Aacute;&Aacute;";
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<p>${Array.from({ length: 50 }, () => encoded).join(" ")}</p>
`,
    }),
    /authored PR description is 450 words; the ceiling is 400/,
  );
});

test("counts an authored section whose heading only looks like the bot's", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: `
## Summary by network

- ${filler(60)}
`,
    }),
    /authored PR description is 463 words; the ceiling is 400/,
  );
});

// The two bodies below differ only by the ten-word indented continuation, and
// the shorter one sits exactly at the ceiling. A counter that reads a four-space
// list continuation as code would pass both.
function bodyWithIndentedTail(continuation) {
  return sizedBody({
    tldrWords: 20,
    problemWords: 100,
    solutionWords: 273,
    extra: `
## Details

- Bullet.
${continuation}`,
  });
}

test("passes at the ceiling without an indented continuation", () => {
  assertPass(bodyWithIndentedTail(""));
});

test("counts an indented list continuation toward the word ceiling", () => {
  assertFail(
    bodyWithIndentedTail(`
    ${filler(10)}
`),
    /authored PR description is 410 words; the ceiling is 400/,
  );
});

test("does not count a fenced code block toward the word ceiling", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

\`\`\`text
${filler(60)}
\`\`\`
`,
    }),
  );
});

test("counts prose wrapped in raw HTML toward the word ceiling", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<details><summary>Overflow</summary>

<p>${filler(50)}</p>

</details>
`,
    }),
    /authored PR description is 451 words; the ceiling is 400/,
  );
});

test("does not count an attribute holding an angle bracket as prose", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 273,
      extra: `
## Details

<div title="${filler(30)} > ${filler(30)}">
<p>Visible.</p>
</div>
`,
    }),
  );
});

test("does not strip a comment delimiter inside an HTML attribute", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 272,
      extra: '\n<div data-example="<!--">one two three four</div>',
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("maps comments in container HTML back to source offsets", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: "\n> <div>\n> a\n> <!-- hidden -->\n> </div>",
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("preserves prose after an indented same-line comment", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: "\n<!-- note -->    overflow",
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("keeps indented same-line prose visible in opening sections", () => {
  assertPass(`## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

<!-- note -->    Visible problem prose.

## The Solution

<!-- note -->    Visible solution prose.
`);
});

test("keeps a standalone comment blank before indented code", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

<!-- template note -->
    code is not explanatory prose
`,
    /Solution.*must contain visible content/,
  );
});

test("ignores container markers inside multiline HTML tags", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 272,
      extra: '\n> <div\n> title="<!--">\n> one two three four\n> </div>',
    }),
    /authored PR description is 401 words; the ceiling is 400/,
  );
});

test("strips comments after a bare closing delimiter", () => {
  assertPass(
    body(`

## Details

<div>
</
<!-- note -->## Deferrals

- #123 follow-up
</div>
`),
    /deferrals declared/,
  );
});

test("counts prose written as numeric character references", () => {
  // "word" as decimal references; GitHub renders it as the word.
  const encoded = "&#119;&#111;&#114;&#100;";
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<p>${Array.from({ length: 50 }, () => encoded).join(" ")}</p>
`,
    }),
    /authored PR description is 450 words; the ceiling is 400/,
  );
});

test("does not count invisible HTML entities as words", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<p>${"&nbsp;".repeat(60)}</p>
`,
    }),
  );
});

test("does not count HTML tags or non-rendering elements as words", () => {
  assertPass(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 274,
      extra: `
## Details

<div class="one two three" data-note="four five six">
<script>${filler(50)}</script>
</div>
`,
    }),
  );
});

test("counts HTML-wrapped prose in the tl;dr toward its limit", () => {
  assertFail(
    `## tl;dr

Visible summary sentence.

<p>${filler(80)}</p>

## The Problem

- Reviewers need a clear problem statement.

## The Solution

- This explains the approach.
`,
    /'## tl;dr' section is 83 words; the limit is 80/,
  );
});

test("counts a section that follows the excluded checklist", () => {
  assertFail(
    sizedBody({
      tldrWords: 20,
      problemWords: 100,
      solutionWords: 275,
      extra: `
## Checklist

- [x] ${filler(60)}

## Details

${filler(1)}
`,
    }),
    /authored PR description is 402 words; the ceiling is 400/,
  );
});

test("accepts the review-eval publication body with the report in Details", () => {
  const report = `## Generated report heading

The report can contain its own headings and a literal \`\`\`\` fence.
`;
  const publicationBody = renderPublicationBody({
    detailDir: "docs/evals/review-skill-runs/example",
    report,
  });
  const fence = "`".repeat(5);
  assert.ok(publicationBody.includes(`${fence}markdown\n${report}${fence}`));
  assertPass(publicationBody);
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
    /must START with '## tl;dr' then '## The Problem'/,
  );
});

test("allows HTML comments before the opening heading", () => {
  assertPass(`<!-- markdownlint-disable MD041 -->

${body()}`);
});

test("fails a comment-only Problem section", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

<!-- Explain the old behavior and effect. -->

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("fails a blank Solution section", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
  assertPass(`## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

Visible problem prose. <!-- template note -->

## The Solution

<!-- prefix --> Visible solution prose.
`);
});

test("counts opening prose between inline-code comment delimiters", () => {
  assertFail(
    `## tl;dr

\`<!--\` ${filler(81)} \`-->\`

## The Problem

\`<!--\` The old behavior hid rendered prose. \`-->\`

## The Solution

\`<!--\` The validator now sees that prose. \`-->\`
`,
    /'## tl;dr' section is 81 words; the limit is 80/,
  );
});

test("accepts Problem prose between inline-code comment delimiters", () => {
  assertPass(`## tl;dr

The validator now preserves visible Markdown beside comment-like inline code, so reviewers can rely on every required opening section being checked accurately.

## The Problem

\`<!--\` The old behavior hid this rendered problem explanation. \`-->\`

## The Solution

The validator keeps visible prose while removing real HTML comments.
`);
});

test("accepts Solution prose between inline-code comment delimiters", () => {
  assertPass(`## tl;dr

The validator now preserves visible Markdown beside comment-like inline code, so reviewers can rely on every required opening section being checked accurately.

## The Problem

The old behavior hid rendered prose beside comment-like inline code.

## The Solution

\`<!--\` The validator now sees this rendered solution explanation. \`-->\`
`);
});

test("does not count visible text inside raw HTML", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

<p>The old behavior failed.</p>

## The Solution

<p>The new behavior avoids that failure.</p>
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count a Markdown paragraph that contains raw HTML", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

The old path failed for operators.<br>

## The Solution

- The new path avoids that failure.
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count a paragraph with raw HTML nested in Markdown", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

Visible text *<span>raw</span>*

## The Solution

- The new path avoids that failure.
`,
    /Problem.*must contain visible content/,
  );
});

test("does not count tag-only raw HTML as explanatory content", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

<br>
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count an HTML attribute delimiter as visible text", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
      `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
      `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

[comment]: # (placeholder)

## The Solution

- This explains the new behavior.
`,
    /Problem.*must contain visible content/,
  );
});

test("fails a Solution section containing only a link-reference definition", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

> [comment]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("accepts the CommonMark maximum label length as a hidden definition", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[${"a".repeat(999)}]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("keeps an over-limit link-reference label as visible content", () => {
  assertPass(`## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[${"a".repeat(1000)}]: /placeholder
`);
});

test("counts a backslash as visible link-label content", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[\\ ]: /placeholder
`,
    /Solution.*must contain visible content/,
  );
});

test("fails a link-reference definition with its title on the next line", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
  assertPass(`## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /unbalanced(destination "template note"
`);
});

test("strips a balanced raw link destination", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: /balanced(destination) "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count a malformed definition that contains raw HTML", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: </placeholder>"template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("strips an angle destination with whitespace before its title", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

[comment]: </placeholder> "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count tab-indented code as explanatory content", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

- Reviewers need a clear problem statement.

## The Solution

\t[comment]: /placeholder "template note"
`,
    /Solution.*must contain visible content/,
  );
});

test("does not count an indented H2 section as Solution content", () => {
  assertFail(
    `## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
-->## tl;dr

The check that reads pull request descriptions now wants a plain summary first.

## The Problem

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
    /must START with '## tl;dr' then '## The Problem'/,
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

test("fails commented Deferrals near misses at every non-H2 depth", () => {
  for (const depth of [1, 3, 4, 5, 6]) {
    for (const separator of [" ", ""]) {
      assertFail(
        body(`

${"#".repeat(depth)}${separator}Def<!-- note -->errals

- #123 follow-up
`),
        /isn't exactly '## Deferrals'/,
      );
    }
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
  assert.match(error.stdout, /must START with '## tl;dr'/);
});

test("CLI guard prints success when invoked with a relative script path", () => {
  const output = execFileSync(process.execPath, [relativeScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PR_BODY: body() },
  });
  assert.match(output, /PR description OK/);
});
