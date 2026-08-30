import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXECUTION_AUTHENTICITY_LIMIT,
  prepareReviewEvalPublication,
  publicationTopLevelSections,
  renderPublicationBody,
} from "./review-eval-publication.mjs";

const GENERATED_REPORT = `## Review-skill eval — 2026-08-29 (full)

**GREEN** — status complete, suite \`review-skill-v1\`, key \`ec451b1f\`

- no paired baseline comparison
`;

function fixture() {
  const parent = mkdtempSync(
    path.join(tmpdir(), "review-eval-publication-test-"),
  );
  const repo = path.join(parent, "repo with spaces & punctuation");
  const detailDir = "docs/evals/review-skill-runs/2026-08-29-example";
  const detail = path.join(repo, detailDir);
  mkdirSync(detail, { recursive: true });
  const plan = {
    schema_version: 1,
    detail_dir: detailDir,
    plan_dir: detail,
    comparability_key: "a".repeat(64),
    cells: [],
  };
  writeFileSync(
    path.join(detail, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  writeFileSync(path.join(detail, "report.md"), GENERATED_REPORT);
  return {
    parent,
    repo,
    detail,
    detailDir,
    plan,
    cleanup() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("normalizes plan_dir and renders the four required top-level sections", () => {
  const run = fixture();
  try {
    const prepared = prepareReviewEvalPublication({
      repoRoot: run.repo,
      detailDir: run.detailDir,
    });
    const normalized = JSON.parse(
      readFileSync(path.join(run.detail, "plan.json"), "utf8"),
    );
    assert.deepEqual(normalized, {
      ...run.plan,
      plan_dir: run.detailDir,
    });
    assert.equal(prepared.changed, true);
    assert.equal(prepared.detailDir, run.detailDir);

    assert.deepEqual(publicationTopLevelSections(prepared.body), [
      "The Problem",
      "The Solution",
      "Details",
      "Validation",
    ]);
    assert.ok(
      prepared.body.includes(GENERATED_REPORT),
      "the report bytes remain intact inside Details",
    );
    assert.match(prepared.body, /Execution-authenticity limit:/);
    assert.ok(prepared.body.includes(EXECUTION_AUTHENTICITY_LIMIT));

    const second = prepareReviewEvalPublication({
      repoRoot: run.repo,
      detailDir: run.detailDir,
    });
    assert.equal(second.changed, false, "normalization is idempotent");
  } finally {
    run.cleanup();
  }
});

test("uses a fence longer than report backticks without changing the report", () => {
  const report = `${GENERATED_REPORT}\nA literal \`\`\`\` marker stays here.\n`;
  const body = renderPublicationBody({
    detailDir: "docs/evals/review-skill-runs/example",
    report,
  });
  const fence = "`".repeat(5);
  assert.ok(body.includes(`${fence}markdown\n${report}${fence}`));
  assert.deepEqual(publicationTopLevelSections(body), [
    "The Problem",
    "The Solution",
    "Details",
    "Validation",
  ]);
});

test("refuses a plan_dir that does not resolve to detail_dir", () => {
  const run = fixture();
  try {
    const other = path.join(run.repo, "docs/evals/review-skill-runs/other");
    mkdirSync(other, { recursive: true });
    const planPath = path.join(run.detail, "plan.json");
    const mismatched = { ...run.plan, plan_dir: other };
    const before = `${JSON.stringify(mismatched, null, 2)}\n`;
    writeFileSync(planPath, before);

    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: run.detailDir,
        }),
      /plan\.json plan_dir resolves to .* not detail_dir/,
    );
    assert.equal(readFileSync(planPath, "utf8"), before);
  } finally {
    run.cleanup();
  }
});

test("refuses an out-of-repository detail target", () => {
  const run = fixture();
  try {
    const outside = path.join(run.parent, "outside");
    mkdirSync(outside);
    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: outside,
        }),
      /detail directory resolves outside the repository/,
    );
  } finally {
    run.cleanup();
  }
});

test("refuses an out-of-repository plan_dir without rewriting plan.json", () => {
  const run = fixture();
  try {
    const outside = path.join(run.parent, "outside-plan");
    mkdirSync(outside);
    const planPath = path.join(run.detail, "plan.json");
    const escaped = { ...run.plan, plan_dir: outside };
    const before = `${JSON.stringify(escaped, null, 2)}\n`;
    writeFileSync(planPath, before);

    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: run.detailDir,
        }),
      /plan\.json plan_dir resolves outside the repository/,
    );
    assert.equal(readFileSync(planPath, "utf8"), before);
  } finally {
    run.cleanup();
  }
});

test("can wrap the generated failure report without broad file access", () => {
  const run = fixture();
  try {
    const failure = "# Review-skill eval: run failed\n\nmodel deadline\n";
    writeFileSync(path.join(run.detail, "failure.md"), failure);
    const prepared = prepareReviewEvalPublication({
      repoRoot: run.repo,
      detailDir: run.detailDir,
      reportFile: "failure.md",
    });
    assert.equal(prepared.reportFile, "failure.md");
    assert.ok(prepared.body.includes(failure));
    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: run.detailDir,
          reportFile: "../outside.md",
        }),
      /reportFile must be report\.md or failure\.md/,
    );
  } finally {
    run.cleanup();
  }
});

test("refuses a hard-linked report without rewriting plan.json", () => {
  const run = fixture();
  try {
    const planPath = path.join(run.detail, "plan.json");
    const before = readFileSync(planPath, "utf8");
    const outside = path.join(run.parent, "outside-report.md");
    writeFileSync(outside, "outside report\n");
    rmSync(path.join(run.detail, "report.md"));
    linkSync(outside, path.join(run.detail, "report.md"));

    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: run.detailDir,
        }),
      /report\.md must have exactly one hard link/,
    );
    assert.equal(readFileSync(planPath, "utf8"), before);
  } finally {
    run.cleanup();
  }
});

test("refuses a symlink report without rewriting plan.json", () => {
  const run = fixture();
  try {
    const planPath = path.join(run.detail, "plan.json");
    const before = readFileSync(planPath, "utf8");
    const outside = path.join(run.parent, "outside-report.md");
    writeFileSync(outside, "outside report\n");
    rmSync(path.join(run.detail, "report.md"));
    symlinkSync(outside, path.join(run.detail, "report.md"));

    assert.throws(
      () =>
        prepareReviewEvalPublication({
          repoRoot: run.repo,
          detailDir: run.detailDir,
        }),
      /report\.md cannot be opened without following links/,
    );
    assert.equal(readFileSync(planPath, "utf8"), before);
  } finally {
    run.cleanup();
  }
});

test("raw cell transcripts stay outside Git and autoreview input", () => {
  const ignore = readFileSync(
    new URL("../../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(ignore, /^\/docs\/evals\/review-skill-runs\/\*\/cells\/$/m);
});

test("the helper has no process-launch or append API", () => {
  const source = readFileSync(
    new URL("./review-eval-publication.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /\bappendFile(?:Sync)?\b/);
});
