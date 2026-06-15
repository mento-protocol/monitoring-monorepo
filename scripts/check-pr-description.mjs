#!/usr/bin/env node

const PLACEHOLDER_RE =
  /\[Plain-English problem|\[Simple explanation of how|\[Implementation details, invariants|\[Commands and results/;
const PROBLEM_HEADING_RE = /^##\s+The Problem\s*$/;
const SOLUTION_HEADING_RE = /^##\s+The Solution\s*$/;
const DEFERRALS_HEADING_RE = /^##\s+Deferrals\s*$/;
const DEFERRALS_STYLE_RE = /^[\t ]{0,3}#{1,6}\s*Deferrals([^A-Za-z0-9_]|$)/i;
const NONE_RE = /^\s*(?:[-*]\s+)?none\s*\.?\s*$/i;
const ISSUE_RE = /#[0-9]+|github\.com\/[^\s]+\/issues\/[0-9]+/;

function linesOf(body) {
  return body.split(/\r?\n/);
}

function stripHtmlCommentLines(body) {
  let inComment = false;
  const kept = [];

  for (const line of linesOf(body)) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      inComment = true;
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n");
}

function stripFencedBlocks(body) {
  let inFence = false;
  const kept = [];

  for (const line of linesOf(body)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    kept.push(line);
  }

  return kept.join("\n");
}

function firstNonBlankLine(body) {
  return linesOf(body).find((line) => line.trim() !== "") ?? "";
}

function h2Headings(body) {
  return linesOf(body).filter((line) => /^##\s/.test(line));
}

function deferralsSection(body) {
  const section = [];
  let inSection = false;

  for (const line of linesOf(body)) {
    if (DEFERRALS_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (inSection) section.push(line);
  }

  return section.join("\n");
}

export function validatePrDescription(body) {
  if (body.trim() === "") {
    return {
      ok: false,
      message:
        "PR description is empty. It must start with '## The Problem' then '## The Solution' (AGENTS.md 'PR description standard').",
    };
  }

  if (PLACEHOLDER_RE.test(body)) {
    return {
      ok: false,
      message:
        "PR description still contains unfilled template placeholders — replace the bracketed prompts with real content.",
    };
  }

  const commentStripped = stripHtmlCommentLines(body);
  const firstLine = firstNonBlankLine(commentStripped);
  const fenceStripped = stripFencedBlocks(commentStripped);
  const secondHeading = h2Headings(fenceStripped)[1] ?? "";

  if (
    !PROBLEM_HEADING_RE.test(firstLine) ||
    !SOLUTION_HEADING_RE.test(secondHeading)
  ) {
    return {
      ok: false,
      message:
        "PR description must START with '## The Problem' then '## The Solution' as its first two sections — exact title-case, exact heading lines, in order, with no content before (only HTML comments may precede '## The Problem'). See AGENTS.md 'PR description standard' / .github/PULL_REQUEST_TEMPLATE.md.",
    };
  }

  const deferralsStyle = linesOf(fenceStripped).filter((line) =>
    DEFERRALS_STYLE_RE.test(line),
  );
  const nearMiss = deferralsStyle.filter(
    (line) => !DEFERRALS_HEADING_RE.test(line),
  );
  if (nearMiss.length > 0) {
    return {
      ok: false,
      message: `PR description has a Deferrals-style heading that isn't exactly '## Deferrals'. Every Deferrals heading must be exactly '## Deferrals' (H2, no trailing punctuation or extra words), or be removed if nothing was knowingly deferred. Offending heading(s): ${nearMiss.slice(0, 3).join(" ")} See AGENTS.md 'Deferral rule'.`,
    };
  }

  if (!linesOf(fenceStripped).some((line) => DEFERRALS_HEADING_RE.test(line))) {
    return {
      ok: true,
      message:
        "PR description OK — opens with '## The Problem' then '## The Solution', no placeholders, no Deferrals section (nothing deferred).",
    };
  }

  const deferrals = deferralsSection(fenceStripped);
  const deferralLines = linesOf(deferrals);
  const items = deferralLines.filter((line) => /^\s*[-*]\s+\S/.test(line));
  const standaloneNone = deferralLines.filter((line) => NONE_RE.test(line));
  if (items.length === 0 && standaloneNone.length === 0) {
    return {
      ok: false,
      message:
        "The '## Deferrals' section must list its content as items: '- None' when nothing was knowingly deferred, or one '- #123 …' / issues-URL item per deferral. Create the issue first (problem description + solution ideas if you have them), then link it here.",
    };
  }

  const badItems = items.filter(
    (line) => !NONE_RE.test(line) && !ISSUE_RE.test(line),
  );
  if (badItems.length > 0) {
    return {
      ok: false,
      message: `Every item in '## Deferrals' must either be 'None' or reference a GitHub issue (#123 or an issues URL) — one linked item does not cover an untracked sibling. Missing issue reference on: ${badItems.slice(0, 3).join(" ")}`,
    };
  }

  return {
    ok: true,
    message:
      "PR description OK — opens with '## The Problem' then '## The Solution', no placeholders, deferrals declared.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validatePrDescription(process.env.PR_BODY ?? "");
  if (result.ok) {
    console.log(result.message);
  } else {
    console.log(`::error::${result.message}`);
    process.exitCode = 1;
  }
}
