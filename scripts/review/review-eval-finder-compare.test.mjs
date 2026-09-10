import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { compareArms, readArm } from "./review-eval-finder-compare.mjs";

const contract = {
  fixtures: [
    { pr: 11, scorable_ids: [1, 2, 3], p1_ids: [1, 2] },
    { pr: 22, scorable_ids: [4, 5], p1_ids: [4] },
    { pr: 33, scorable_ids: [6], p1_ids: [] },
  ],
};

/** A detail directory holding only what the comparison reads. */
function writeArm({ finder, cells, results, skillDigest = "skill", judge }) {
  const dir = mkdtempSync(path.join(tmpdir(), "finder-compare-"));
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      kind: "finder",
      comparability_key: "key",
      judge: judge ?? { model: "claude-opus-5", effort: "high" },
      inputs: {
        skill_digest: skillDigest,
        finder_argv_digest: "argv",
        orchestrator_digest: "orch",
      },
      cells: cells.map((pr) => ({
        cell_id: `pr-${pr}-pipeline-draw1`,
        pr,
        condition: "pipeline",
        draw: 1,
        finder,
      })),
    }),
  );
  for (const [pr, record] of Object.entries(results)) {
    writeFileSync(
      path.join(dir, `result-${pr}-pipeline-1.json`),
      JSON.stringify({
        pr: Number(pr),
        condition: "pipeline",
        draw: 1,
        matched_ids: record.matched,
        novel: { novelWrong: record.wrong ?? 0 },
      }),
    );
  }
  return dir;
}

test("the comparison pairs pipeline draw-1 cells by PR and nets the matches", () => {
  const anchorDir = writeArm({
    finder: "sol@high",
    cells: [11, 22, 33],
    results: {
      11: { matched: [1, 2], wrong: 1 },
      22: { matched: [], wrong: 2 },
      33: { matched: [6] },
    },
  });
  const candidateDir = writeArm({
    finder: "astra@low",
    cells: [11, 22],
    results: {
      11: { matched: [1] },
      22: { matched: [4, 5], wrong: 0 },
    },
  });
  const anchor = readArm({ dir: anchorDir, contract });
  const candidate = readArm({ dir: candidateDir, contract });
  const report = compareArms({ anchor, candidate });

  assert.deepEqual(
    report.rows.map((row) => [row.pr, row.net]),
    [
      [11, -1],
      [22, 2],
    ],
  );
  // PR 11 froze P1 defects 1 and 2; the candidate matched only one of them.
  assert.deepEqual(
    report.rows.map((row) => [row.anchor.p1_matched, row.candidate.p1_matched]),
    [
      [2, 1],
      [0, 1],
    ],
  );
  assert.equal(report.totals.net, 1);
  assert.equal(report.totals.anchor.matched, 2);
  assert.equal(report.totals.candidate.matched, 3);
  assert.deepEqual(report.totals.anchor, {
    matched: 2,
    p1_matched: 2,
    p1_opportunities: 3,
    wrong_claims: 3,
  });
  assert.equal(report.totals.candidate.wrong_claims, 0);
  // PR 33 ran in one arm only, so it is skipped and named rather than scored.
  assert.deepEqual(report.skipped.anchor_only, [33]);
  assert.deepEqual(report.skipped.candidate_only, []);
  assert.equal(report.sign_flip.n, 2);
  assert.equal(report.sign_flip.net, 1);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.notes, []);
});

test("a different skill or judge warns; a different orchestrator only notes", () => {
  const results = { 11: { matched: [1] } };
  const anchor = readArm({
    dir: writeArm({ finder: "sol@high", cells: [11], results }),
    contract,
  });
  const candidate = readArm({
    dir: writeArm({
      finder: "astra@low",
      cells: [11],
      results,
      skillDigest: "other-skill",
      judge: { model: "claude-opus-5", effort: "low" },
    }),
    contract,
  });
  const report = compareArms({ anchor, candidate });
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /different review skills/);
  assert.match(report.warnings[1], /judge differs/);

  candidate.identity.skill_digest = anchor.identity.skill_digest;
  candidate.identity.judge = anchor.identity.judge;
  candidate.identity.orchestrator_digest = "other-orchestrator";
  const second = compareArms({ anchor, candidate });
  assert.deepEqual(second.warnings, []);
  assert.equal(second.notes.length, 1);
  assert.match(second.notes[0], /orchestrator sources differ/);
});
