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
function writeArm({
  finder,
  cells,
  results,
  skillDigest = "skill",
  judge,
  contractDigest = null,
  matcherDigest = "matcher",
  calibrationDigest = "calibset",
  comparabilityKey = "key",
  // The shape the committed anchor row records.
  calibration = { agreement: 39, total: 40 },
  writeRow = true,
}) {
  const dir = mkdtempSync(path.join(tmpdir(), "finder-compare-"));
  if (writeRow) {
    writeFileSync(
      path.join(dir, "row.json"),
      JSON.stringify({ kind: "finder", judge_calibration: calibration }),
    );
  }
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      kind: "finder",
      comparability_key: comparabilityKey,
      contract_digest: contractDigest,
      matcher_digest: matcherDigest,
      calibration_digest: calibrationDigest,
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

test("a different contract on either side warns", () => {
  // Every count here is recomputed from the contract this process loaded, so a
  // run planned against other fixture bits is read through a scoring key it
  // never ran under. That difference is a contract difference, not a finder one.
  const results = { 11: { matched: [1] } };
  const anchor = readArm({
    dir: writeArm({
      finder: "sol@high",
      cells: [11],
      results,
      contractDigest: "aaaa1111",
    }),
    contract,
  });
  const candidate = readArm({
    dir: writeArm({
      finder: "astra@low",
      cells: [11],
      results,
      contractDigest: "bbbb2222",
    }),
    contract,
  });
  const split = compareArms({
    anchor,
    candidate,
    contractDigest: "aaaa1111",
  });
  assert.equal(split.warnings.length, 2);
  assert.match(split.warnings[0], /planned against different contracts/);
  assert.match(split.warnings[1], /the candidate was planned against contract/);

  // Both arms agreeing with each other but not with the loaded contract is two
  // warnings as well: the counts still come from bits neither run saw.
  candidate.identity.contract_digest = "aaaa1111";
  anchor.identity.contract_digest = "aaaa1111";
  const drifted = compareArms({
    anchor,
    candidate,
    contractDigest: "cccc3333",
  });
  assert.equal(drifted.warnings.length, 2);
  assert.ok(
    drifted.warnings.every((warning) =>
      /recomputed from cccc3333/.test(warning),
    ),
  );

  // Agreement all round warns about nothing.
  assert.deepEqual(
    compareArms({ anchor, candidate, contractDigest: "aaaa1111" }).warnings,
    [],
  );
});

test("a different scorer, calibration set or key warns", () => {
  // Each of these decides what a matched id counts as, so a difference in any
  // of them is not a finder difference. The key was printed but never flagged.
  const results = { 11: { matched: [1] } };
  const base = { finder: "sol@high", cells: [11], results };
  for (const [changed, pattern] of [
    [{ matcherDigest: "other-matcher" }, /different scorers/],
    [
      { calibrationDigest: "other-calibset" },
      /different judge calibration sets/,
    ],
    [{ comparabilityKey: "other-key" }, /different comparability keys/],
  ]) {
    const anchor = readArm({ dir: writeArm(base), contract });
    const candidate = readArm({
      dir: writeArm({ ...base, finder: "astra@low", ...changed }),
      contract,
    });
    const report = compareArms({ anchor, candidate });
    assert.equal(report.warnings.length, 1, JSON.stringify(changed));
    assert.match(report.warnings[0], pattern);
  }
});

test("a run whose judge failed calibration is refused, not compared", () => {
  // Every matched id on both sides was read by that judge. A run under the
  // floor cannot support a finder claim in either direction, and printing its
  // nets beside a passing run's invites exactly that.
  const base = {
    finder: "sol@high",
    cells: [11],
    results: { 11: { matched: [1] } },
  };
  const failed = writeArm({
    ...base,
    calibration: { agreement: 34, total: 40 },
  });
  assert.throws(
    () => readArm({ dir: failed, contract }),
    /recorded judge calibration 34\/40, which does not pass/,
  );
  const missing = writeArm({ ...base, calibration: null });
  assert.throws(
    () => readArm({ dir: missing, contract }),
    /recorded judge calibration nothing/,
  );
  const noRow = writeArm({ ...base, writeRow: false });
  assert.throws(() => readArm({ dir: noRow, contract }), /carries no row.json/);
  // 37/40 is the floor itself, and it passes.
  const floor = writeArm({
    ...base,
    calibration: { agreement: 37, total: 40 },
  });
  assert.deepEqual(
    readArm({ dir: floor, contract }).identity.judge_calibration,
    {
      agreement: 37,
      total: 40,
    },
  );
});
