// Verifies that the repository's normative guardrail sentences are still where
// the agent instructions promise they are.
//
// The strongest rules this repo has — never merge without explicit approval,
// secrets are IaC-owned, Terraform apply needs human approval, forensic drafts
// stay local — exist only as prose in AGENTS.md and
// docs/notes/pr-operating-card.md. Agents and documentation gardening edit
// those files routinely, and nothing reds when a load-bearing sentence quietly
// disappears in an unrelated cleanup. This check pins each sentence so removing
// one has to be a deliberate, same-PR edit to the pin list rather than an
// invisible side effect.
//
// Pins are matched after whitespace normalization: every run of whitespace in
// both the file and the snippet collapses to a single space. Prose reflow — a
// Prettier rewrap, a sentence moving across a line break — therefore never
// fails the check. Only the words changing does.
//
// The pins are deliberately short, one clause each. A pinned paragraph would
// turn every reword into a CI failure and train people to edit the pin without
// reading it, which is the opposite of what this protects.
//
// Root CLAUDE.md is pinned separately even though it is a symlink to AGENTS.md
// and `readFileSync` follows it, so both key blocks read the same bytes today.
// CLAUDE.md is the path the Claude runtime actually loads, and nothing else in
// the repository asserts it stays a symlink. The duplicated block costs four
// lines and starts failing the moment that link is replaced by a divergent
// regular file or dropped.
//
// NON-GOAL: this check does not pin script digests. The gate and helper scripts
// in this repo are legitimately agent-maintained and change often; digest pins
// there would be noise. This protects normative prose only.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(scriptDir, "../..");
const DEFAULT_PINS = path.join(scriptDir, "guardrail-prose.json");

const USAGE = `Usage: node scripts/repo-health/check-guardrail-prose.mjs

Verifies that every normative sentence pinned in
scripts/repo-health/guardrail-prose.json still appears in the file that is
supposed to carry it. Snippets are compared after whitespace normalization, so
reflowed prose still passes; only changed words fail.

Exits nonzero and names the file and the missing snippet when a pin no longer
matches, or when a pinned file is missing or unreadable.

Environment:
  GUARDRAIL_PROSE_ROOT  Repository root to check. Default: the repo root
  GUARDRAIL_PROSE_PINS  Pin file to read. Default: scripts/repo-health/guardrail-prose.json
`;

/** The instruction printed with every failure, so the fix is never guesswork. */
export const REMEDY =
  "Restore the sentence, or change the pin in " +
  "scripts/repo-health/guardrail-prose.json in the same PR as a deliberate " +
  "rule change.";

/**
 * Collapse every whitespace run to a single space and trim.
 *
 * Applied to both sides of the comparison. This is what makes a pin survive
 * prose reflow: a snippet written on one line still matches the same sentence
 * wrapped across three, and Markdown list indentation stops mattering.
 */
export function normalizeProse(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * The top-level keys of a JSON object literal, in source order, duplicates kept.
 *
 * `JSON.parse` keeps only the last of two identical keys and reports nothing,
 * so a pin file that repeats a path silently discards every pin in the earlier
 * block. Nothing downstream can see it: the parsed object is well formed, the
 * remaining pins all match, and the check exits 0 while protecting less than
 * the file says it does. That is the one way this checker could fail open, so
 * the collision is found in the raw text instead. A `JSON.parse` reviver cannot
 * do it — the reviver walks the already-collapsed result and is handed the
 * repeated key once.
 *
 * The scan consumes whole string literals, so a snippet containing `:` or a
 * brace never registers as a key, and only depth 1 counts, so strings inside
 * the snippet arrays are skipped. Callers run it after `JSON.parse` has
 * succeeded and the root has been confirmed to be an object.
 *
 * @param {string} text raw JSON source
 * @returns {string[]}
 */
export function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      const literal = text.slice(index, end + 1);
      index = end + 1;
      if (depth === 1) {
        let probe = index;
        while (probe < text.length && /\s/.test(text[probe])) probe += 1;
        if (text[probe] === ":") keys.push(JSON.parse(literal));
      }
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    index += 1;
  }
  return keys;
}

/**
 * Read and validate the pin file.
 *
 * Fails closed on any shape that is not `{ "<path>": ["<snippet>", ...] }` with
 * non-empty strings throughout. A malformed pin file must never read as "no
 * pins to check" — that is a check that passes while protecting nothing.
 *
 * @returns {{ pins: [string, string[]][], problems: string[] }}
 */
export function loadPins(pinPath) {
  let raw;
  let parsed;
  try {
    raw = readFileSync(pinPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      pins: [],
      problems: [`cannot read pin file ${pinPath}: ${error.message}`],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      pins: [],
      problems: [
        `pin file ${pinPath} must be an object mapping file paths to snippet arrays`,
      ],
    };
  }

  const seen = topLevelKeys(raw);
  const duplicated = [
    ...new Set(seen.filter((key, at) => seen.indexOf(key) !== at)),
  ];
  if (duplicated.length > 0) {
    return {
      pins: [],
      problems: duplicated.map(
        (key) =>
          `pin file ${pinPath}: ${key} is declared more than once; only the last block would be checked and the earlier pins would be dropped silently`,
      ),
    };
  }

  const problems = [];
  const pins = [];
  for (const [file, snippets] of Object.entries(parsed)) {
    if (!Array.isArray(snippets) || snippets.length === 0) {
      problems.push(
        `pin file ${pinPath}: ${file} must list at least one snippet`,
      );
      continue;
    }
    const invalid = snippets.filter(
      (snippet) =>
        typeof snippet !== "string" || normalizeProse(snippet) === "",
    );
    if (invalid.length > 0) {
      problems.push(
        `pin file ${pinPath}: ${file} has a snippet that is not a non-empty string`,
      );
      continue;
    }
    pins.push([file, snippets]);
  }

  if (pins.length === 0 && problems.length === 0) {
    problems.push(`pin file ${pinPath} declares no pins`);
  }
  return { pins, problems };
}

/**
 * Check every pinned snippet against the file that must carry it.
 *
 * @param {string} root repository root the pinned paths are relative to
 * @param {[string, string[]][]} pins
 * @returns {{ file: string, kind: "unreadable" | "missing-snippet", detail: string }[]}
 */
export function checkGuardrailProse(root, pins) {
  const failures = [];
  for (const [file, snippets] of pins) {
    let contents;
    try {
      contents = readFileSync(path.join(root, file), "utf8");
    } catch (error) {
      failures.push({
        file,
        kind: "unreadable",
        detail: `pinned file is missing or unreadable (${error.code ?? error.message})`,
      });
      continue;
    }
    const haystack = normalizeProse(contents);
    for (const snippet of snippets) {
      if (!haystack.includes(normalizeProse(snippet))) {
        failures.push({ file, kind: "missing-snippet", detail: snippet });
      }
    }
  }
  return failures;
}

/** The failure report, as the lines it should be printed on. */
export function formatFailures(failures) {
  const lines = ["check-guardrail-prose: pinned guardrail prose is missing:"];
  for (const failure of failures) {
    lines.push(
      failure.kind === "unreadable"
        ? `  ${failure.file}: ${failure.detail}`
        : `  ${failure.file}: missing snippet: ${failure.detail}`,
    );
  }
  lines.push("", REMEDY);
  return lines;
}

function main(argv) {
  const [flag] = argv;
  if (flag === "-h" || flag === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flag !== undefined) {
    process.stderr.write(USAGE);
    return 1;
  }

  const root = process.env.GUARDRAIL_PROSE_ROOT ?? DEFAULT_ROOT;
  const pinPath = process.env.GUARDRAIL_PROSE_PINS ?? DEFAULT_PINS;

  const { pins, problems } = loadPins(pinPath);
  if (problems.length > 0) {
    process.stderr.write(
      `${["check-guardrail-prose: the pin list itself is unusable:", ...problems.map((problem) => `  ${problem}`)].join("\n")}\n`,
    );
    return 1;
  }

  const failures = checkGuardrailProse(root, pins);
  if (failures.length > 0) {
    process.stderr.write(`${formatFailures(failures).join("\n")}\n`);
    return 1;
  }

  const snippetCount = pins.reduce(
    (total, [, snippets]) => total + snippets.length,
    0,
  );
  process.stdout.write(
    `check-guardrail-prose: ${snippetCount} pinned sentences present across ${pins.length} files\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = main(process.argv.slice(2));
}
