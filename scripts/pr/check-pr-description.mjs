#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";

const PLACEHOLDER_RE =
  /\[Two to four plain sentences|\[Plain-English problem|\[Simple explanation of how|\[Implementation details, invariants|\[Commands and results/;
const TLDR_HEADING_RE = /^##\s+tl;dr\s*$/;
const PROBLEM_HEADING_RE = /^##\s+The Problem\s*$/;
const SOLUTION_HEADING_RE = /^##\s+The Solution\s*$/;
const H2_HEADING_RE = /^ {0,3}##(?:[\t ]+|$)/;
const CHECKLIST_HEADING_RE = /^ {0,3}##[\t ]+Checklist\s*$/;
const TASK_LIST_ITEM_RE = /^ {0,3}[-*+][\t ]+\[[ xX]\][\t ]/;
// Only the review bot's own appended section is exempt. A prefix match would
// also exempt an authored heading such as '## Summary by network', and with it
// every word under that heading.
const BOT_SUMMARY_HEADING_RE = /^ {0,3}##[\t ]+Summary by CodeRabbit\s*$/i;
// Tag matching steps over quoted attribute values, so a '>' inside one does not
// end the tag early and leave the rest of the attribute counted as prose.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_ATTRIBUTES = "[^>\"']*(?:(?:\"[^\"]*\"|'[^']*')[^>\"']*)*";
const HTML_HIDDEN_RE = new RegExp(
  `<(script|style|template)\\b${HTML_ATTRIBUTES}>[\\s\\S]*?</\\1\\s*>`,
  "gi",
);
const HTML_TAG_RE = new RegExp(`<${HTML_ATTRIBUTES}>`, "g");
const HTML_ENTITY_RE =
  /&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/g;
// GitHub renders a character reference as a character, so the counter decodes
// one rather than dropping it: prose encoded as `&#119;`-style references is
// prose. Listed here are the names that render as nothing a word can be built
// from; every other name decodes to a counting letter, so an unlisted name such
// as `&Aacute;` adds a word instead of disappearing.
const BLANK_ENTITIES = new Set([
  "nbsp",
  "ensp",
  "emsp",
  "emsp13",
  "emsp14",
  "numsp",
  "puncsp",
  "thinsp",
  "hairsp",
  "zwnj",
  "zwj",
  "lrm",
  "rlm",
  "shy",
]);
// Names that render as punctuation or a symbol. They add no word, so listing
// them keeps a body that writes `&mdash;` from being counted one word over.
const PUNCTUATION_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["horbar", "―"],
  ["hellip", "…"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["bull", "•"],
  ["middot", "·"],
  ["dagger", "†"],
  ["Dagger", "‡"],
  ["sect", "§"],
  ["para", "¶"],
  ["times", "×"],
  ["divide", "÷"],
  ["plusmn", "±"],
  ["minus", "−"],
  ["deg", "°"],
  ["prime", "′"],
  ["Prime", "″"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["euro", "€"],
  ["pound", "£"],
  ["yen", "¥"],
  ["cent", "¢"],
  ["larr", "←"],
  ["rarr", "→"],
  ["harr", "↔"],
  ["darr", "↓"],
  ["uarr", "↑"],
  ["check", "✓"],
  ["cross", "✗"],
]);
// Any other name renders as at least one visible character, so it counts.
const ENTITY_PLACEHOLDER = "x";
const DEFERRALS_HEADING_RE = /^##\s+Deferrals\s*$/;
const DEFERRALS_STYLE_RE = /^ {0,3}#{1,6}\s*Deferrals([^A-Za-z0-9_]|$)/i;
const NONE_RE = /^\s*(?:[-*]\s+)?none\s*\.?\s*$/i;
const ISSUE_RE = /#[0-9]+|github\.com\/[^\s]+\/issues\/[0-9]+/;

// The tl;dr is two to four plain sentences, about 60 words. The hard stop sits
// above that so a slightly long summary is a nudge, not a build break.
const TLDR_MAX_WORDS = 80;
// A reviewer reads the authored body in about two minutes. 250 words is typical;
// 400 is the ceiling. The template's own checklist, HTML comments, code blocks,
// and the review bot's appended summary section are not authored body.
const BODY_MAX_WORDS = 400;

function linesOf(body) {
  return body.split(/\r?\n/);
}

function stripHtmlCommentLines(body) {
  let inComment = false;
  const kept = [];

  for (const originalLine of linesOf(body)) {
    let line = originalLine;
    let output = "";
    let strippedComment = false;

    while (line !== "") {
      if (inComment) {
        const close = line.indexOf("-->");
        if (close === -1) {
          break;
        }
        inComment = false;
        strippedComment = true;
        line = line.slice(close + 3);
        continue;
      }

      const open = line.indexOf("<!--");
      if (open === -1) {
        output += line;
        break;
      }

      output += line.slice(0, open);
      strippedComment = true;

      const close = line.indexOf("-->", open + 4);
      if (close === -1) {
        inComment = true;
        break;
      }

      line = line.slice(close + 3);
    }

    if (strippedComment && output.trim() === "") {
      continue;
    }

    kept.push(strippedComment ? output.trimStart() : output);
  }

  return kept.join("\n");
}

function stripFencedBlocks(body) {
  let openFence = null;
  const kept = [];

  for (const line of linesOf(body)) {
    if (openFence !== null) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
      if (
        closing !== null &&
        closing[1][0] === openFence.marker &&
        closing[1].length >= openFence.length
      ) {
        openFence = null;
      }
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening !== null) {
      const marker = opening[1][0];
      const info = opening[2];
      if (marker !== "`" || !info.includes("`")) {
        openFence = { marker, length: opening[1].length };
        continue;
      }
    }

    kept.push(line);
  }

  return { body: kept.join("\n"), hasUnclosedFence: openFence !== null };
}

function firstNonBlankLine(body) {
  return linesOf(body).find((line) => line.trim() !== "") ?? "";
}

function h2Headings(body) {
  return linesOf(body).filter((line) => H2_HEADING_RE.test(line));
}

function hasVisibleCharacters(value) {
  return value.replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim() !== "";
}

function containsHtml(node) {
  return (
    node.type === "html" ||
    (Array.isArray(node.children) && node.children.some(containsHtml))
  );
}

function hasVisibleText(node) {
  if (node.type === "text" || node.type === "inlineCode") {
    return hasVisibleCharacters(node.value);
  }
  if (
    node.type === "code" ||
    node.type === "definition" ||
    node.type === "html"
  ) {
    return false;
  }
  if (!Array.isArray(node.children)) return false;
  if (node.type === "paragraph" && containsHtml(node)) return false;
  return node.children.some(hasVisibleText);
}

function sectionContent(body, headingPattern) {
  const sourceLines = linesOf(body);
  const tree = fromMarkdown(body);
  let inSection = false;

  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 2) {
      if (inSection) break;
      const headingLine = sourceLines[node.position.start.line - 1] ?? "";
      if (headingPattern.test(headingLine)) inSection = true;
      continue;
    }
    if (inSection && hasVisibleText(node)) return "visible";
  }

  return "";
}

function countWords(text) {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
    .length;
}

/**
 * Words inside raw HTML. A reader sees prose wrapped in `<p>` or a
 * `<details>` block, so it counts against the budget even though the opening
 * sections do not accept it as their explanation. Tags, attributes, and
 * non-rendering elements contribute nothing.
 */
function decodeCharacterReference(match, decimal, hex, name) {
  if (decimal !== undefined || hex !== undefined) {
    const code = Number.parseInt(
      decimal ?? hex,
      decimal === undefined ? 16 : 10,
    );
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return " ";
    // A surrogate half is not a character GitHub renders on its own.
    if (code >= 0xd800 && code <= 0xdfff) return " ";
    return String.fromCodePoint(code);
  }
  // Reference names are case-sensitive: `&Dagger;` is ‡ and `&dagger;` is †,
  // so the lookup keeps the case the body used.
  if (BLANK_ENTITIES.has(name)) return " ";
  return PUNCTUATION_ENTITIES.get(name) ?? ENTITY_PLACEHOLDER;
}

function htmlWordCount(value) {
  return countWords(
    value
      .replace(HTML_COMMENT_RE, " ")
      .replace(HTML_HIDDEN_RE, " ")
      // Tags go before decoding, so a `&lt;p&gt;` the reader sees as text is
      // never mistaken for markup.
      .replace(HTML_TAG_RE, " ")
      .replace(HTML_ENTITY_RE, decodeCharacterReference),
  );
}

/**
 * Words a reader sees, counted from the Markdown tree rather than from raw
 * lines. An indented continuation of a list item is visible prose, not code, so
 * only real code is skipped.
 */
function visibleWordCount(markdown) {
  let words = 0;

  const walk = (node) => {
    if (node.type === "code" || node.type === "definition") return;
    if (node.type === "html") {
      words += htmlWordCount(node.value);
      return;
    }
    if (node.type === "text" || node.type === "inlineCode") {
      words += countWords(node.value);
      return;
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };

  walk(fromMarkdown(markdown));
  return words;
}

/** Lines under an exact H2 heading, up to the next H2. */
function sectionLines(body, headingPattern) {
  const section = [];
  let inSection = false;

  for (const line of linesOf(body)) {
    if (headingPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && H2_HEADING_RE.test(line)) break;
    if (inSection) section.push(line);
  }

  return section;
}

/**
 * Words the author wrote. The template's ticked boxes and the review bot's
 * appended summary section do not count; prose parked under `## Checklist` does,
 * because only the task-list items themselves are template content. HTML
 * comments and fenced code are already gone from the body this receives.
 */
function authoredWordCount(body) {
  const kept = [];
  let section = "body";

  for (const line of linesOf(body)) {
    if (H2_HEADING_RE.test(line)) {
      if (CHECKLIST_HEADING_RE.test(line)) {
        section = "checklist";
        continue;
      }
      if (BOT_SUMMARY_HEADING_RE.test(line)) {
        section = "bot";
        continue;
      }
      section = "body";
    }
    if (section === "bot") continue;
    if (section === "checklist" && TASK_LIST_ITEM_RE.test(line)) continue;
    kept.push(line);
  }

  return visibleWordCount(kept.join("\n"));
}

function deferralsSection(body) {
  const section = [];
  let inSection = false;

  for (const line of linesOf(body)) {
    if (DEFERRALS_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && H2_HEADING_RE.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection) section.push(line);
  }

  return section.join("\n");
}

export function validatePrDescription(body) {
  if (body.trim() === "") {
    return {
      ok: false,
      message:
        "PR description is empty. It must start with '## tl;dr' then '## The Problem' then '## The Solution' (AGENTS.md 'PR description standard').",
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
  const { body: fenceStripped, hasUnclosedFence } =
    stripFencedBlocks(commentStripped);

  if (hasUnclosedFence) {
    return {
      ok: false,
      message:
        "PR description contains an unclosed fenced code block. Close the fence before the rest of the description so required sections cannot be hidden.",
    };
  }

  // Keep the opening check stricter than the later section scan: a leading code
  // fence is real content before '## tl;dr' and must stay rejected.
  const headings = h2Headings(fenceStripped);
  const secondHeading = headings[1] ?? "";
  const thirdHeading = headings[2] ?? "";

  if (
    !TLDR_HEADING_RE.test(firstLine) ||
    !PROBLEM_HEADING_RE.test(secondHeading) ||
    !SOLUTION_HEADING_RE.test(thirdHeading)
  ) {
    return {
      ok: false,
      message:
        "PR description must START with '## tl;dr' then '## The Problem' then '## The Solution' as its first three sections — exact heading lines (the tl;dr heading is lowercase), in order, with no content before (only HTML comments may precede '## tl;dr'). See AGENTS.md 'PR description standard' / .github/PULL_REQUEST_TEMPLATE.md.",
    };
  }

  if (sectionContent(fenceStripped, TLDR_HEADING_RE) === "") {
    return {
      ok: false,
      message:
        "The '## tl;dr' section must contain visible content in Markdown: two to four plain sentences, about 60 words, that say who had the problem, what this PR changes, and what the reader should expect. Raw HTML other than comments, paragraphs that contain it, template comments by themselves, and code blocks do not count.",
    };
  }

  const tldrWords = visibleWordCount(
    sectionLines(fenceStripped, TLDR_HEADING_RE).join("\n"),
  );
  if (tldrWords > TLDR_MAX_WORDS) {
    return {
      ok: false,
      message: `The '## tl;dr' section is ${tldrWords} words; the limit is ${TLDR_MAX_WORDS}. Write two to four plain sentences, about 60 words, and move the detail into '## Details'.`,
    };
  }

  if (sectionContent(fenceStripped, PROBLEM_HEADING_RE) === "") {
    return {
      ok: false,
      message:
        "The '## The Problem' section must contain visible content in Markdown that explains the change. Raw HTML other than comments, paragraphs that contain it, template comments by themselves, and code blocks do not count.",
    };
  }

  if (sectionContent(fenceStripped, SOLUTION_HEADING_RE) === "") {
    return {
      ok: false,
      message:
        "The '## The Solution' section must contain visible content in Markdown that explains the change. Raw HTML other than comments, paragraphs that contain it, template comments by themselves, and code blocks do not count.",
    };
  }

  const bodyWords = authoredWordCount(fenceStripped);
  if (bodyWords > BODY_MAX_WORDS) {
    return {
      ok: false,
      message: `The authored PR description is ${bodyWords} words; the ceiling is ${BODY_MAX_WORDS} and about 250 is typical. The template checklist, HTML comments, code blocks, and the '## Summary by CodeRabbit' section do not count. Cut until it fits — move long reasoning to the commit message, an ADR, the linked issue, or a review comment.`,
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
        "PR description OK — opens with '## tl;dr' then '## The Problem' then '## The Solution', within the word budget, no placeholders, no Deferrals section (nothing deferred).",
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
      "PR description OK — opens with '## tl;dr' then '## The Problem' then '## The Solution', within the word budget, no placeholders, deferrals declared.",
  };
}

function isCliEntrypoint() {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isCliEntrypoint()) {
  const result = validatePrDescription(process.env.PR_BODY ?? "");
  if (result.ok) {
    console.log(result.message);
  } else {
    console.log(`::error::${result.message}`);
    process.exitCode = 1;
  }
}
