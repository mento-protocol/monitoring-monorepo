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
// A 64-hex digest that still reads as its label in a failure message.
const HEX = (label) =>
  (label.replace(/[^0-9a-f]/g, "0") + "0".repeat(64)).slice(0, 64);

function writeArm({
  finder,
  cells,
  results,
  skillDigest = "skill",
  judge,
  contractDigest = HEX("aaaa1111"),
  matcherDigest = HEX("matcher"),
  calibrationDigest = HEX("calibset"),
  comparabilityKey = "key",
  // The shape the committed anchor row records.
  calibration = { agreement: 39, total: 40 },
  writeRow = true,
  notes = "",
  codexCli = "codex-cli 0.154.0",
  claudeCli = "2.1.267 (Claude Code)",
  // The manifest scorePlan writes; defaults to every cell that has a result.
  completedCellIds = null,
  writeManifest = true,
}) {
  const dir = mkdtempSync(path.join(tmpdir(), "finder-compare-"));
  if (writeRow) {
    writeFileSync(
      path.join(dir, "row.json"),
      JSON.stringify({
        kind: "finder",
        judge_calibration: calibration,
        notes,
      }),
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
        codex_cli: codexCli,
        claude_cli: claudeCli,
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
  if (writeManifest) {
    writeFileSync(
      path.join(dir, "calibration.json"),
      JSON.stringify({
        completed_cell_ids:
          completedCellIds ??
          Object.keys(results).map((pr) => `pr-${pr}-pipeline-draw1`),
      }),
    );
  }
  for (const [pr, record] of Object.entries(results)) {
    writeFileSync(
      path.join(dir, `result-${pr}-pipeline-1.json`),
      JSON.stringify({
        pr: Number(pr),
        condition: "pipeline",
        draw: 1,
        matched_ids: record.matched,
        novel: record.novel ?? { novelWrong: record.wrong ?? 0 },
        leak: { suspected: record.leaked === true, hard: [], advisory: [] },
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

test("a scoring-input mismatch is refused, not warned about", () => {
  // The contract freezes the ids and the recall denominator, the scorer decides
  // what matches one, and the calibration set is what qualified the judge. A net
  // computed across a difference in any of them answers no question at all.
  const results = { 11: { matched: [1] } };
  const base = { finder: "sol@high", cells: [11], results };
  for (const [changed, pattern] of [
    [{ contractDigest: HEX("bbbb2222") }, /different contracts/],
    [{ matcherDigest: HEX("other-matcher") }, /different scorers/],
    [
      { calibrationDigest: HEX("other-calibset") },
      /different judge calibration sets/,
    ],
  ]) {
    const anchor = readArm({
      dir: writeArm({ ...base, contractDigest: HEX("aaaa1111") }),
      contract,
    });
    const candidate = readArm({
      dir: writeArm({
        ...base,
        finder: "astra@low",
        contractDigest: HEX("aaaa1111"),
        ...changed,
      }),
      contract,
    });
    assert.throws(
      () => compareArms({ anchor, candidate }),
      pattern,
      JSON.stringify(changed),
    );
  }
});

test("a straddled CLI upgrade warns and names the runtime that moved", () => {
  const results = { 11: { matched: [1] } };
  const base = {
    finder: "sol@high",
    cells: [11],
    results,
    contractDigest: HEX("aaaa1111"),
  };
  const anchor = readArm({ dir: writeArm(base), contract });
  const candidate = readArm({
    dir: writeArm({
      ...base,
      finder: "astra@low",
      codexCli: "codex-cli 9.9.9",
    }),
    contract,
  });
  const report = compareArms({ anchor, candidate });
  assert.ok(report.warnings.some((w) => /codex CLI/.test(w)));
  assert.ok(!report.warnings.some((w) => /claude CLI/.test(w)));
});

test("a root result outside the completed-cell manifest is stale and reads as missing", () => {
  const results = { 11: { matched: [1] }, 22: { matched: [4, 5] } };
  const base = {
    finder: "sol@high",
    cells: [11, 22],
    results,
    contractDigest: HEX("aaaa1111"),
  };
  const anchor = readArm({ dir: writeArm(base), contract });
  // PR 22 succeeded on an earlier run of this directory and failed on retry:
  // its result file is still on disk, the manifest no longer lists it.
  const candidate = readArm({
    dir: writeArm({
      ...base,
      finder: "astra@low",
      completedCellIds: ["pr-11-pipeline-draw1"],
    }),
    contract,
  });
  const report = compareArms({ anchor, candidate });
  assert.equal(report.totals.prs, 1);
  assert.deepEqual(report.skipped.anchor_only, [22]);
  assert.throws(
    () =>
      readArm({ dir: writeArm({ ...base, writeManifest: false }), contract }),
    /calibration\.json/,
  );
});

test("a numeric string id matches the contract's number; a non-integer id is refused", () => {
  const anchor = readArm({
    dir: writeArm({
      finder: "sol@high",
      cells: [11],
      results: { 11: { matched: [1] } },
    }),
    contract,
  });
  const strings = readArm({
    dir: writeArm({
      finder: "astra@low",
      cells: [11],
      results: { 11: { matched: ["1"] } },
    }),
    contract,
  });
  assert.equal(compareArms({ anchor, candidate: strings }).totals.net, 0);
  assert.throws(
    () =>
      readArm({
        dir: writeArm({
          finder: "astra@low",
          cells: [11],
          results: { 11: { matched: ["x"] } },
        }),
        contract,
      }),
    /not an integer id/,
  );
  assert.throws(
    () =>
      readArm({
        dir: writeArm({
          finder: "astra@low",
          cells: [11],
          results: { 11: { matched: [999] } },
        }),
        contract,
      }),
    /not a scorable id/,
  );
});

test("--allow-scorer-drift turns the scorer refusal into a warning, nothing else", () => {
  // A probe is planned on a branch that edits scoring modules, so its scorer
  // digest never equals the anchor's. The operator who has read that diff can
  // accept it; the difference is still printed, and the contract and the
  // calibration set are still refused.
  const results = { 11: { matched: [1] } };
  const base = {
    finder: "sol@high",
    cells: [11],
    results,
    contractDigest: HEX("aaaa1111"),
  };
  const anchor = readArm({ dir: writeArm(base), contract });
  const drifted = readArm({
    dir: writeArm({
      ...base,
      finder: "astra@low",
      matcherDigest: HEX("other"),
    }),
    contract,
  });
  assert.throws(() => compareArms({ anchor, candidate: drifted }), /scorers/);
  const report = compareArms({
    anchor,
    candidate: drifted,
    allowScorerDrift: true,
  });
  assert.equal(report.totals.prs, 1);
  assert.ok(report.warnings.some((w) => /allow-scorer-drift/.test(w)));
  const other = readArm({
    dir: writeArm({ ...base, calibrationDigest: HEX("other-calibset") }),
    contract,
  });
  assert.throws(
    () => compareArms({ anchor, candidate: other, allowScorerDrift: true }),
    /calibration sets/,
  );
});

test("an arm that disagrees with the loaded contract is refused; the scorer warns", () => {
  // Both arms can agree with each other and still be read through bits neither
  // of them ran under: every count here is recomputed from what this process
  // loaded, not from what the runs recorded.
  const results = { 11: { matched: [1] } };
  const base = {
    finder: "sol@high",
    cells: [11],
    results,
    contractDigest: HEX("aaaa1111"),
    matcherDigest: HEX("mmmm1111"),
  };
  const anchor = readArm({ dir: writeArm(base), contract });
  const candidate = readArm({
    dir: writeArm({ ...base, finder: "astra@low" }),
    contract,
  });
  assert.throws(
    () => compareArms({ anchor, candidate, contractDigest: HEX("cccc3333") }),
    /planned against contract aaaa1111, but these counts are recomputed from cccc3333/,
  );
  // The loaded scorer only warns. It did not produce either arm's matched ids,
  // and it moves whenever any scoring module is edited — the normal state of
  // the branch a probe is planned on — so refusing on it would refuse every
  // probe against every earlier anchor, including this repo's own.
  const drifted = compareArms({
    anchor,
    candidate,
    matcherDigest: HEX("nnnn2222"),
  });
  assert.equal(drifted.warnings.length, 1);
  assert.match(
    drifted.warnings[0],
    /both runs were scored under 00001111, but this checkout's scorer is 00002222/,
  );
  assert.equal(drifted.totals.prs, 1);
  // Agreement all round refuses nothing and warns about nothing.
  assert.deepEqual(
    compareArms({
      anchor,
      candidate,
      contractDigest: HEX("aaaa1111"),
      matcherDigest: HEX("mmmm1111"),
    }).warnings,
    [],
  );
});

test("a different comparability key warns but never refuses", () => {
  // The key binds the orchestrator digest, and a probe of a new finder is
  // normally planned on an edited harness, so its key always differs from the
  // anchor's. Refusing on it would make every probe incomparable with every
  // anchor, which is the whole point of the lane.
  const results = { 11: { matched: [1] } };
  const base = { finder: "sol@high", cells: [11], results };
  const anchor = readArm({ dir: writeArm(base), contract });
  const candidate = readArm({
    dir: writeArm({ ...base, finder: "astra@low", comparabilityKey: "other" }),
    contract,
  });
  const report = compareArms({ anchor, candidate });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /different comparability keys/);
  assert.equal(report.totals.prs, 1);
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

test("a leaked run is refused, from the row or from any cell", () => {
  // `scorePlan` keeps a leaked cell's matched ids so the leak stays visible in
  // the detail, and the canonical baseline path refuses such a row for the same
  // reason this does: the answer key may have reached the contestant, so a
  // matched id no longer measures the finder.
  const leakedCell = writeArm({
    finder: "sol@high",
    cells: [11, 22],
    results: { 11: { matched: [1] }, 22: { matched: [4], leaked: true } },
  });
  assert.throws(
    () => readArm({ dir: leakedCell, contract }),
    /records a suspected leak on PR 22/,
  );
  const leakedRow = writeArm({
    finder: "sol@high",
    cells: [11],
    results: { 11: { matched: [1] } },
    notes: "leak suspected: the transcript names a withheld commit",
  });
  assert.throws(
    () => readArm({ dir: leakedRow, contract }),
    /records a suspected leak in its row notes/,
  );
});

test("a result missing its wrong-claim count is refused, not read as zero", () => {
  // Every committed result carries `novel.novelWrong`. Defaulting an absent one
  // to 0 would silently hand the arm a perfect wrong-claims score.
  for (const novel of [{}, { novelWrong: -1 }, { novelWrong: 1.5 }]) {
    const dir = writeArm({
      finder: "sol@high",
      cells: [11],
      results: { 11: { matched: [1], novel } },
    });
    assert.throws(
      () => readArm({ dir, contract }),
      /carries novel\.novelWrong .*; a nonnegative integer is required/,
      JSON.stringify(novel),
    );
  }
});
