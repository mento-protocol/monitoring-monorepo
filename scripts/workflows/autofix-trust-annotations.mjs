/**
 * The annotation-comment scoping pass of the autofix CI-trust checker.
 *
 * `js-yaml` discards comments, but the `# autofix-ci-trust:` escape hatch IS a
 * comment, so the checker needs one raw-text pass over the workflow source to
 * find annotations and attribute them to jobs. That pass is source scanning,
 * not trust analysis: it decides which lines are genuine YAML comments and
 * which job body each one sits in. It is split out here so
 * `check-autofix-ci-trust.mjs` reads as trigger, credential, and guard
 * analysis over the parsed document alone.
 *
 * Behavioral coverage lives in `check-autofix-ci-trust.test.mjs`, which
 * exercises this pass through `evaluateWorkflow`.
 */

/** The literal an author writes to document why a credential job needs no
 * excluding autofix guard. */
export const ANNOTATION = "# autofix-ci-trust:";
const ANNOTATION_LINE = /^\s*#\s*autofix-ci-trust:/;

/** The quote character (`"` or `'`) left OPEN at the end of `line`, given the
 * quote state entering it — or null when the line ends outside any quote.
 * Honors `\`-escapes inside `"…"` and `''`-escapes inside `'…'`, and stops at
 * an unquoted `#` (a YAML comment start, at line-start or after whitespace). A
 * best-effort scanner: any imprecision only ever marks MORE lines as scalar
 * content, which fails CLOSED for annotation detection (an uncredited
 * annotation just means the job must guard instead). */
function quoteStateAfter(line, openQuote) {
  let q = openQuote;
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k];
    if (q === '"') {
      if (c === "\\") k += 1;
      else if (c === '"') q = null;
    } else if (q === "'") {
      if (c === "'") {
        if (line[k + 1] === "'") k += 1;
        else q = null;
      }
    } else {
      if (c === "#" && (k === 0 || /\s/.test(line[k - 1]))) break;
      if (c === '"' || c === "'") q = c;
    }
  }
  return q;
}

/** Mark every source line that is scalar CONTENT — inside a block scalar
 * (`run: |`, `script: >-`) or a continuation of a multiline quoted scalar
 * (`key: "a\n# not-a-comment\nb"`). A line-leading `#` in either is string
 * content, not a YAML comment, so it must not be read as an annotation.
 *
 * The two are tracked in ONE pass with quote state checked FIRST: a structural
 * line that ends inside an open quote opens a quoted scalar (its trailing `|`
 * is a character INSIDE the string, never a block-scalar introducer), and only
 * a line that ends OUTSIDE any quote can introduce a block scalar. That
 * ordering is what stops a quoted continuation ending in `|` from being
 * misread as a block introducer (which would reset the quote state and let a
 * later `#` line in the same scalar pose as a comment). */
function scalarContentLines(lines) {
  const content = new Array(lines.length).fill(false);
  let inQuote = null; // open quote char, or null
  let blockIndent = null; // indent of the active block-scalar introducer, or null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (blockIndent !== null) {
      if (line.trim() === "" || line.search(/\S/) > blockIndent) {
        content[i] = true;
        continue;
      }
      blockIndent = null; // dedented out of the block scalar — reprocess line
    }
    if (inQuote) {
      content[i] = true;
      inQuote = quoteStateAfter(line, inQuote);
      continue;
    }
    // Structural line. A quote it leaves OPEN wins over a `|` introducer (the
    // `|` would be inside that quote).
    const q = quoteStateAfter(line, null);
    if (q) {
      inQuote = q;
      continue;
    }
    if (
      !/^\s*#/.test(line) &&
      /(?:^|\s)[|>][0-9+-]{0,2}\s*(#.*)?$/.test(line)
    ) {
      blockIndent = line.search(/\S/);
    }
  }
  return content;
}

/**
 * Locate `# autofix-ci-trust:` annotation comments in the SOURCE and attribute
 * them to jobs. `js-yaml` discards comments, so this is the one raw-text pass.
 * It is anchored to the parser's ground truth and attributes UNAMBIGUOUSLY:
 *   1. Only GENUINE comment lines count — a `#` line inside a block scalar OR a
 *      multiline quoted scalar is string content, not a comment, and is excluded.
 *   2. Each job's key line is matched at the exact job-block indentation (not
 *      any depth), so a same-named nested key — an `outputs:` entry called
 *      `deploy`, say — cannot be mistaken for the `deploy` job.
 *   3. A JOB annotation must sit INSIDE that job's body: after its key line and
 *      indented deeper than the key. A comment at job-key indent between jobs
 *      documents the job BELOW it (universal convention), and a column-0 footer
 *      after the last job belongs to no job — neither may silence a credential
 *      job it happens to physically follow.
 *   4. A FILE annotation must sit above `jobs:` (the true header); a comment
 *      inside the jobs section is scoped to a job, never file-wide.
 *
 * @param {string} body
 * @param {string[]} jobNames
 * @returns {{ fileAnnotated: boolean, jobAnnotated: (name: string) => boolean }}
 */
export function annotationScopes(body, jobNames) {
  const lines = body.split("\n");
  const inScalar = scalarContentLines(lines);
  const annotationLines = [];
  lines.forEach((line, i) => {
    if (!inScalar[i] && ANNOTATION_LINE.test(line)) annotationLines.push(i);
  });
  if (annotationLines.length === 0) {
    return { fileAnnotated: false, jobAnnotated: () => false };
  }
  const jobsLine = lines.findIndex(
    (l, i) => !inScalar[i] && /^(['"]?)jobs\1\s*:\s*(#.*)?$/.test(l),
  );
  // Indentation of the job keys: the first real mapping key under `jobs:`.
  let jobIndent = null;
  if (jobsLine >= 0) {
    for (let i = jobsLine + 1; i < lines.length; i += 1) {
      if (inScalar[i] || lines[i].trim() === "" || /^\s*#/.test(lines[i]))
        continue;
      const ind = lines[i].search(/\S/);
      if (ind === 0) break; // dedented out of the jobs block
      jobIndent = ind;
      break;
    }
  }
  const jobStart = new Map();
  if (jobIndent != null) {
    const pad = " ".repeat(jobIndent);
    for (const name of jobNames) {
      const re = new RegExp(
        `^${pad}(['"]?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1\\s*:`,
      );
      for (let i = jobsLine + 1; i < lines.length; i += 1) {
        if (!inScalar[i] && re.test(lines[i])) {
          jobStart.set(name, i);
          break;
        }
      }
    }
  }
  const ordered = [...jobStart.entries()].sort((a, b) => a[1] - b[1]);
  // File-level annotation: a comment ABOVE `jobs:` (the true header). This is
  // deliberately stricter than "before the first job": a comment sitting
  // between `jobs:` and the first job key, or at job-key indent above a job,
  // documents the job BELOW it by universal convention and must not blanket
  // the whole file.
  const fileAnnotated =
    jobsLine >= 0 && annotationLines.some((i) => i < jobsLine);
  const jobAnnotated = (name) => {
    const idx = jobStart.get(name);
    if (idx == null || jobIndent == null) return false;
    const pos = ordered.findIndex(([n]) => n === name);
    const end = pos + 1 < ordered.length ? ordered[pos + 1][1] : lines.length;
    // The annotation must be UNAMBIGUOUSLY inside this job's body: strictly
    // after its key line, before the next job, and indented DEEPER than the
    // job key. A comment at job-key indent (or shallower) between two jobs
    // describes the following job — crediting it to the preceding one silences
    // the wrong job; a column-0 footer after the last job belongs to no job at
    // all. Requiring deeper indentation ties the annotation to the job it is
    // structurally part of.
    return annotationLines.some(
      (i) => i > idx && i < end && lines[i].search(/\S/) > jobIndent,
    );
  };
  return { fileAnnotated, jobAnnotated };
}
