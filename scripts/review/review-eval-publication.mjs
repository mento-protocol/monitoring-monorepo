#!/usr/bin/env node

// Prepare one completed review-eval run for the normal PR workflow. This file
// is intentionally outside SCORING_MODULES. It changes publication metadata
// and presentation only; it never runs or scores the evaluation.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const EXECUTION_AUTHENTICITY_LIMIT =
  "The committed row, plan, scored results, and calibration can prove internal consistency only. They do not prove that a model produced the committed results. A pull request author can create a mutually consistent evidence set or change the branch validator. Hostile-author resistance requires a protected validator and execution evidence that the pull request author cannot change.";
const REPORT_FILES = new Set(["report.md", "failure.md"]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireDirectory(target, name) {
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    throw new Error(`${name} does not exist: ${target}`, { cause: error });
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${name} must be a directory: ${target}`);
  }
}

function readRegularFile(target, name) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error(
      "this platform cannot open publication files without following symlinks",
    );
  }
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(
      `${name} cannot be opened without following links: ${target}`,
      {
        cause: error,
      },
    );
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`${name} must be a regular file: ${target}`);
    }
    if (metadata.nlink !== 1) {
      throw new Error(`${name} must have exactly one hard link: ${target}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requireInRepo(root, target, name) {
  if (!isInside(root, target)) {
    throw new Error(`${name} resolves outside the repository: ${target}`);
  }
}

function realDirectory(target, name) {
  requireDirectory(target, name);
  try {
    return realpathSync(target);
  } catch (error) {
    throw new Error(`${name} cannot be resolved: ${target}`, { cause: error });
  }
}

function resolveRecordedDirectory(value, repoRoot, name) {
  requireNonEmptyString(value, name);
  const target = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(repoRoot, value);
  const physical = realDirectory(target, name);
  requireInRepo(repoRoot, physical, name);
  return physical;
}

function readPlan(planPath) {
  const text = readRegularFile(planPath, "plan.json");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new Error(`plan.json is not valid JSON: ${planPath}`, {
      cause: error,
    });
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error(`plan.json must contain one JSON object: ${planPath}`);
  }
  return { plan, text };
}

function requireReportFile(value) {
  const selected = value ?? "report.md";
  if (!REPORT_FILES.has(selected)) {
    throw new Error("reportFile must be report.md or failure.md");
  }
  return selected;
}

function longestBacktickRun(value) {
  return Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
}

export function publicationTopLevelSections(body) {
  const headings = [];
  let openFence = null;
  for (const line of String(body).split(/\r?\n/)) {
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
      openFence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = line.match(/^ {0,3}##[\t ]+(.+?)[\t ]*$/);
    if (heading !== null) headings.push(heading[1]);
  }
  return headings;
}

function assertPublicationSections(body) {
  const expected = ["The Problem", "The Solution", "Details", "Validation"];
  const actual = publicationTopLevelSections(body);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `rendered PR body must contain exactly ${expected.join(", ")} as its top-level sections; got ${actual.join(", ") || "none"}`,
    );
  }
}

/** Render the complete generated report under Details without promoting its H2. */
export function renderPublicationBody({ detailDir, report }) {
  requireNonEmptyString(detailDir, "detailDir");
  requireNonEmptyString(report, "report");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(report) + 1));
  const reportSeparator = report.endsWith("\n") ? "" : "\n";
  const quotedDetail = JSON.stringify(detailDir);

  const body = [
    "## The Problem",
    "",
    "- The review-eval runner records `plan_dir` as an absolute checkout path. Publishing that value exposes a machine-specific path and makes the artifact non-portable.",
    "- The generated report does not contain the four opening sections required for pull requests in this repository. Using it directly as the PR body fails the description contract.",
    "",
    "## The Solution",
    "",
    "- Normalize `plan_dir` only after the selected detail directory, `detail_dir`, and `plan_dir` resolve to the same directory inside the repository.",
    "- Place the complete generated report in a repository-compliant PR body. This helper prepares local publication files only. It does not run models, append ledger rows, push, open a pull request, or merge.",
    "",
    "## Details",
    "",
    `- Detail directory: ${quotedDetail}.`,
    `- Execution-authenticity limit: ${EXECUTION_AUTHENTICITY_LIMIT}`,
    "",
    "### Complete generated report",
    "",
    `${fence}markdown`,
    `${report}${reportSeparator}${fence}`,
    "",
    "## Validation",
    "",
    "- This helper resolved all three directory references to one physical in-repository directory before it rewrote `plan_dir`.",
    "- `scripts/pr/check-pr-description.test.mjs` checks this renderer with the repository's PR-description validator. That test proves the generated shape satisfies the current validator. It does not revalidate the ledger row or authenticate model execution.",
    "",
  ].join("\n");
  assertPublicationSections(body);
  return body;
}

function writeJsonAtomically(target, value) {
  const temporary = `${target}.publication-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Normalize plan_dir and return the validated PR body. This is the helper's
 * only mutation. The caller owns validation, staging, Git, and GitHub.
 */
export function prepareReviewEvalPublication({
  repoRoot,
  detailDir,
  reportFile = "report.md",
}) {
  const requestedRoot = path.resolve(
    requireNonEmptyString(repoRoot, "repoRoot"),
  );
  const physicalRoot = realDirectory(requestedRoot, "repository root");
  const selectedDetail = requireNonEmptyString(detailDir, "detailDir");
  const requestedDetail = path.isAbsolute(selectedDetail)
    ? path.resolve(selectedDetail)
    : path.resolve(requestedRoot, selectedDetail);
  const physicalDetail = realDirectory(requestedDetail, "detail directory");
  requireInRepo(physicalRoot, physicalDetail, "detail directory");

  const relativeDetail = path
    .relative(physicalRoot, physicalDetail)
    .split(path.sep)
    .join(path.posix.sep);
  const planPath = path.join(physicalDetail, "plan.json");
  const selectedReport = requireReportFile(reportFile);
  const reportPath = path.join(physicalDetail, selectedReport);
  const { plan, text: originalPlan } = readPlan(planPath);

  const recordedDetailValue = requireNonEmptyString(
    plan.detail_dir,
    "plan.json detail_dir",
  );
  if (path.isAbsolute(recordedDetailValue)) {
    throw new Error("plan.json detail_dir must be repository-relative");
  }
  const recordedDetail = resolveRecordedDirectory(
    recordedDetailValue,
    physicalRoot,
    "plan.json detail_dir",
  );
  if (recordedDetail !== physicalDetail) {
    throw new Error(
      `plan.json detail_dir resolves to ${recordedDetail}, not the selected detail directory ${physicalDetail}`,
    );
  }

  const recordedPlan = resolveRecordedDirectory(
    plan.plan_dir,
    physicalRoot,
    "plan.json plan_dir",
  );
  if (recordedPlan !== physicalDetail) {
    throw new Error(
      `plan.json plan_dir resolves to ${recordedPlan}, not detail_dir ${physicalDetail}`,
    );
  }

  const report = readRegularFile(reportPath, selectedReport);
  const body = renderPublicationBody({ detailDir: relativeDetail, report });

  const normalizedPlan = { ...plan, plan_dir: relativeDetail };
  const normalizedText = `${JSON.stringify(normalizedPlan, null, 2)}\n`;
  if (normalizedText !== originalPlan) {
    writeJsonAtomically(planPath, normalizedPlan);
  }

  return {
    body,
    detailDir: relativeDetail,
    planPath,
    reportFile: selectedReport,
    changed: normalizedText !== originalPlan,
  };
}

function usage() {
  return `Usage: node scripts/review/review-eval-publication.mjs --detail-dir DIR [--report-file report.md|failure.md] [--root PATH]\n\nValidates and normalizes one completed run for manual publication. The PR body\nis written to stdout. The helper performs no model, ledger, Git, or GitHub action.\n`;
}

function parseCli(argv) {
  const parsed = parseNodeArgs({
    args: argv,
    options: {
      "detail-dir": { type: "string" },
      "report-file": { type: "string" },
      root: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) return { help: true };
  return {
    help: false,
    repoRoot: parsed.values.root ?? process.cwd(),
    detailDir: requireNonEmptyString(
      parsed.values["detail-dir"],
      "--detail-dir",
    ),
    reportFile: requireReportFile(parsed.values["report-file"]),
  };
}

function isCliEntrypoint() {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

if (isCliEntrypoint()) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const prepared = prepareReviewEvalPublication(options);
      process.stdout.write(prepared.body);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`review-eval-publication: ${message}\n`);
    process.exitCode = 1;
  }
}
