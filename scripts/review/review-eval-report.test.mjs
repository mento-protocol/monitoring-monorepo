#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freshness, validateLedgerRow } from "./review-eval-ledger.mjs";
import {
  compareConditions,
  headlineCondition,
  loadTruthIndex,
  mcnemar,
  parseLeadingReviewEvalMarkers,
  perDefectBits,
  renderReport,
  REPORT_MAX_LINES,
  REVIEW_EVAL_ISSUE_LABELS,
  REVIEW_EVAL_MARKER,
  reviewEvalMonthMarker,
  scheduleIssuePayload,
  verdict,
} from "./review-eval-report.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
    "utf8",
  ),
);
const rules = contract.verdict_rules;
const truth = loadTruthIndex({ contract, repoRoot });
const gridIds = contract.fixtures
  .filter((fixture) => fixture.grid)
  .flatMap((fixture) => fixture.scorable_ids.map(String));
const allIds = contract.fixtures.flatMap((fixture) =>
  fixture.scorable_ids.map(String),
);
const CONTRACT_DIGEST = "a".repeat(64);
const KEY = "c".repeat(64);
const OTHER_KEY = "9".repeat(64);

/** Build one condition whose first `found` defects are found in every draw. */
function condition({
  ids = allIds,
  found = 0,
  draws = 2,
  p1Matched = 8,
  p1Opportunities = 12,
  ...overrides
} = {}) {
  const perDefect = Object.fromEntries(
    ids.map((id, index) => [
      id,
      Array.from({ length: draws }, () => (index < found ? 1 : 0)),
    ]),
  );
  const matched = found * draws;
  const opportunities = ids.length * draws;
  return {
    model: "claude-opus-5",
    effort: "high",
    finder: "gpt-5.6-sol@high",
    draws,
    recall: {
      matched,
      opportunities,
      rate: Number((matched / opportunities).toFixed(3)),
    },
    p1: {
      matched: p1Matched,
      opportunities: p1Opportunities,
      rate: Number((p1Matched / p1Opportunities).toFixed(3)),
    },
    novel_real: 11,
    wrong_claims: 6,
    usd: 44.1,
    seconds: 6820,
    per_defect: perDefect,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    schema_version: 1,
    kind: "full",
    executed_at: "2026-12-08T10:41:07Z",
    status: "complete",
    verdict: "GREEN",
    comparability_key: KEY,
    contract_digest: CONTRACT_DIGEST,
    inputs: {
      skill_digest: "d".repeat(64),
      skill_ref: "installed",
      finder_argv_digest: "e".repeat(64),
      orchestrator_digest: "f".repeat(64),
      claude_cli: "2.1.14",
      codex_cli: "0.48.2",
      host: "chapati-mbp",
    },
    conditions: { pipeline: condition({ found: 20 }) },
    judge_calibration: { agreement: 40, total: 40 },
    vs_baseline: null,
    detail_dir: "docs/evals/review-skill-runs/2026-12-08-3f9c1a58",
    notes: "",
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return row({
    executed_at: "2026-09-08T10:41:07Z",
    detail_dir: "docs/evals/review-skill-runs/2026-09-08-3f9c1a58",
    ...overrides,
  });
}

/** A `replay` condition: the grid defects only, both frozen reports replayed. */
function replay(overrides = {}) {
  return condition({ ids: gridIds, draws: 2, ...overrides });
}

test("the fixtures used by these assertions are themselves valid rows", () => {
  assert.deepEqual(validateLedgerRow(row()), []);
  assert.deepEqual(
    validateLedgerRow(
      row({
        kind: "canary",
        conditions: {
          replay: condition({
            ids: gridIds,
            found: 10,
            draws: 1,
            p1Matched: 4,
            p1Opportunities: 6,
          }),
        },
      }),
    ),
    [],
  );
});

test("mcnemar counts paired flips and refuses unusable vectors", () => {
  assert.deepEqual(mcnemar([1, 1, 0, 0], [1, 0, 1, 0]), {
    b: 1,
    c: 1,
    delta: 0,
  });
  assert.deepEqual(mcnemar([1, 1, 1], [0, 0, 0]), { b: 3, c: 0, delta: 3 });
  assert.deepEqual(mcnemar([0, 0, 0], [1, 1, 1]), { b: 0, c: 3, delta: -3 });
  assert.deepEqual(mcnemar([], []), { b: 0, c: 0, delta: 0 });
  assert.throws(() => mcnemar([1, 0], [1]), /same length/);
  assert.throws(() => mcnemar([1, 2], [1, 0]), /must be 0 or 1/);
  assert.throws(() => mcnemar("10", [1, 0]), /two arrays/);
});

test("a defect counts as found when any draw of the run found it", () => {
  const bits = perDefectBits({
    per_defect: { 100: [0, 0], 101: [0, 1], 102: [1, 1] },
  });
  assert.deepEqual(
    [...bits.entries()],
    [
      ["100", 0],
      ["101", 1],
      ["102", 1],
    ],
  );
  const compared = compareConditions(
    { per_defect: { 100: [1, 1], 101: [1, 0], 103: [1, 1] } },
    { per_defect: { 100: [0, 0], 101: [1, 1], 102: [1, 1] } },
  );
  assert.deepEqual(compared.lost, ["100"]);
  assert.deepEqual(compared.gained, []);
  assert.equal(compared.delta, 1);
  // 103 and 102 were scored by only one run, so neither counts as a flip.
  assert.equal(compared.skipped, 2);
});

test("verdict applies the pre-registered rule to every branch", () => {
  const cases = [
    {
      name: "GREEN when nothing moved",
      row: row(),
      baseline: baseline(),
      expect: "GREEN",
      reason: /inside the noise floor/,
    },
    {
      name: "GREEN for a first run with no baseline",
      row: row(),
      baseline: null,
      expect: "GREEN",
      reason: /no baseline row/,
    },
    {
      name: "RED at the net-flip threshold",
      row: row({ conditions: { pipeline: condition({ found: 14 }) } }),
      baseline: baseline(),
      expect: "RED",
      reason: /lost a net 6 defects/,
    },
    {
      name: "AMBER one flip short of the threshold",
      row: row({ conditions: { pipeline: condition({ found: 15 }) } }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /inside the noise floor/,
    },
    {
      name: "RED below the P1 recall floor",
      row: row({
        conditions: {
          pipeline: condition({ found: 20, p1Matched: 7, p1Opportunities: 12 }),
        },
      }),
      baseline: baseline(),
      expect: "RED",
      reason: /below p1_recall_floor/,
    },
    {
      name: "RED at twice the baseline wrong-claim count",
      row: row({
        conditions: { pipeline: condition({ found: 20, wrong_claims: 12 }) },
      }),
      baseline: baseline(),
      expect: "RED",
      reason: /wrong claims against a baseline of 6/,
    },
    {
      name: "RED when a condition parsed nothing on two PRs",
      row: row({
        conditions: {
          pipeline: condition({ found: 20 }),
          control: condition({ found: 6, zero_finding_prs: 2 }),
        },
      }),
      baseline: baseline(),
      expect: "RED",
      reason: /no parseable finding on 2 PRs/,
    },
    {
      name: "AMBER on a partial matrix",
      row: row({ status: "partial" }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /run status is partial/,
    },
    {
      // The cells that never ran are the cells that would have supplied the
      // missing P1 matches. Reading a subset's P1 recall as a floor breach
      // opens a priority issue naming defects the run never had the chance to
      // find, so the incomplete matrix is read before the RED floors.
      name: "AMBER, not RED, when a partial matrix is below the P1 floor",
      row: row({
        status: "partial",
        conditions: {
          pipeline: condition({ found: 20, p1Matched: 0, p1Opportunities: 12 }),
        },
      }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /run status is partial/,
    },
    {
      name: "AMBER, not RED, when a partial matrix parsed nothing on two PRs",
      row: row({
        status: "partial",
        conditions: {
          pipeline: condition({ found: 20 }),
          control: condition({ found: 6, zero_finding_prs: 2 }),
        },
      }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /run status is partial/,
    },
    {
      // The anchor's bits are the denominator of every flip count after it.
      // Ranking against answer-key-contaminated bits scores each later clean
      // run as a regression against defects the anchor may have read.
      name: "AMBER when the named baseline records a suspected leak",
      row: row(),
      baseline: baseline({ notes: "leak suspected: transcript names PR 1999" }),
      expect: "AMBER",
      reason: /baseline notes record a suspected leak/,
    },
    {
      name: "AMBER on judge drift",
      row: row({ judge_calibration: { agreement: 33, total: 40 } }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /below 37\/40/,
    },
    {
      // The scorer writes this note verbatim; see scorePlan in
      // review-eval-run.mjs. The rule must read what the producer writes.
      name: "AMBER on a suspected leak",
      row: row({
        notes: "leak suspected: transcript names PR 1999",
      }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /suspected leak/,
    },
    {
      name: "AMBER on a suspected leak spelled with an underscore",
      row: row({ notes: "leak_suspected: PR number in transcript" }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /suspected leak/,
    },
    {
      name: "RED at twice a zero-wrong-claim baseline, floored at one",
      row: row({
        conditions: { pipeline: condition({ found: 20, wrong_claims: 2 }) },
      }),
      baseline: baseline({
        conditions: { pipeline: condition({ found: 20, wrong_claims: 0 }) },
      }),
      expect: "RED",
      reason: /baseline floored at 1/,
    },
    {
      name: "AMBER when the control moved with the pipeline",
      row: row({
        conditions: {
          pipeline: condition({ found: 16 }),
          control: condition({ found: 4, draws: 1 }),
        },
      }),
      baseline: baseline({
        conditions: {
          pipeline: condition({ found: 20 }),
          control: condition({ found: 10, draws: 1 }),
        },
      }),
      expect: "AMBER",
      reason: /control moved 6 defects in the same direction/,
    },
    {
      name: "AMBER when the baseline is not comparable",
      row: row(),
      baseline: baseline({ comparability_key: OTHER_KEY }),
      expect: "AMBER",
      reason: /cannot be ranked against the given baseline/,
    },
    {
      name: "PROMOTE on a net gain past the threshold replay corroborates",
      row: row({
        conditions: {
          pipeline: condition({ found: 26 }),
          replay: replay({ found: 13 }),
        },
      }),
      baseline: baseline({
        conditions: {
          pipeline: condition({ found: 20 }),
          replay: replay({ found: 10 }),
        },
      }),
      expect: "PROMOTE",
      reason: /gained a net 6 defects/,
    },
    {
      name: "INCOMPLETE when the run failed",
      row: row({ status: "failed", notes: "codex CLI unauthenticated" }),
      baseline: baseline(),
      expect: "INCOMPLETE",
      reason: /codex CLI unauthenticated/,
    },
  ];
  for (const item of cases) {
    const decision = verdict({
      contract,
      row: item.row,
      baselineRow: item.baseline,
    });
    assert.equal(decision.verdict, item.expect, item.name);
    assert.ok(
      decision.reasons.some((reason) => item.reason.test(reason)),
      `${item.name}: expected ${item.reason} in ${JSON.stringify(decision.reasons)}`,
    );
  }
});

test("a suspected leak is AMBER before any RED condition is read", () => {
  // Every RED path a leaked run can take: the P1 floor, the wrong-claim
  // ceiling, and a condition that parsed nothing on two PRs. A run that may
  // have read the answer key produced evidence the runbook calls untrusted, so
  // escalating on it is as wrong as passing on it.
  const leaked = { notes: "leak suspected: transcript names PR 1999" };
  const cases = [
    row({
      ...leaked,
      conditions: {
        pipeline: condition({ found: 20, p1Matched: 7, p1Opportunities: 12 }),
      },
    }),
    row({
      ...leaked,
      conditions: { pipeline: condition({ found: 20, wrong_claims: 12 }) },
    }),
    row({
      ...leaked,
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ found: 6, zero_finding_prs: 2 }),
      },
    }),
  ];
  for (const leakedRow of cases) {
    const decision = verdict({
      contract,
      row: leakedRow,
      baselineRow: baseline(),
    });
    assert.equal(decision.verdict, "AMBER", JSON.stringify(decision.reasons));
    assert.match(decision.reasons.join("\n"), /suspected leak/);
  }
  // The same note on a canary, where the grid floor is the RED path.
  const canary = verdict({
    contract,
    row: row({
      ...leaked,
      kind: "canary",
      conditions: { replay: condition({ ids: gridIds, found: 0, draws: 1 }) },
    }),
  });
  assert.equal(canary.verdict, "AMBER", JSON.stringify(canary.reasons));
  assert.match(canary.reasons.join("\n"), /suspected leak/);
});

test("an uncalibrated baseline is refused before it ranks anything", () => {
  // The baseline supplies baseHeadline, every flip, and the wrong-claim
  // denominator. Below 37/40 those numbers are unusable, so they may not turn a
  // calibrated candidate RED or PROMOTE.
  const unusable = baseline({
    judge_calibration: { agreement: 33, total: 40 },
  });
  const regressed = verdict({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 14 }) } }),
    baselineRow: unusable,
  });
  assert.equal(regressed.verdict, "AMBER", JSON.stringify(regressed.reasons));
  assert.match(
    regressed.reasons.join("\n"),
    /baseline judge calibration 33\/40 is below 37\/40/,
  );
  const promoted = verdict({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 26 }) } }),
    baselineRow: unusable,
  });
  assert.equal(promoted.verdict, "AMBER", JSON.stringify(promoted.reasons));
  // The report reads the same pairing, so it prints no McNemar line either.
  assert.match(
    renderReport({ contract, row: row(), baselineRow: unusable, truth }),
    /No paired baseline comparison for this row\./,
  );
});

test("a baseline that postdates the candidate is refused", () => {
  // `resolveBaseline` only ever anchors on an earlier row. Pairing against a
  // later one reverses the reading: what the candidate found and the later row
  // did not is counted as lost, so a regression can print PROMOTE.
  const later = baseline({ executed_at: "2027-01-08T10:41:07Z" });
  const regressed = verdict({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 14 }) } }),
    baselineRow: later,
  });
  assert.equal(regressed.verdict, "AMBER", JSON.stringify(regressed.reasons));
  assert.match(
    regressed.reasons.join("\n"),
    /baseline executed_at 2027-01-08T10:41:07Z does not precede this row's 2026-12-08T10:41:07Z/,
  );
  // A row named as its own baseline is the same fault: every flip is zero.
  assert.equal(
    verdict({
      contract,
      row: row(),
      baselineRow: baseline({ executed_at: "2026-12-08T10:41:07Z" }),
    }).verdict,
    "AMBER",
  );
  // The report reads the same pairing, so it prints no McNemar line either.
  assert.match(
    renderReport({ contract, row: row(), baselineRow: later, truth }),
    /No paired baseline comparison for this row\./,
  );
});

test("verdict refuses to rank a pair sharing fewer than three defects", () => {
  const twoDefects = { ids: allIds.slice(0, 2), found: 2 };
  const paired = verdict({
    contract,
    row: row({ conditions: { pipeline: condition(twoDefects) } }),
    baselineRow: baseline({
      conditions: { pipeline: condition(twoDefects) },
    }),
  });
  assert.equal(paired.verdict, "AMBER");
  assert.match(
    paired.reasons.join("\n"),
    /share only 2 scored defect\(s\); noise_floor_defects 3 refuses to rank/,
  );
  // A pair that clears the floor still ranks the ordinary way.
  const threeDefects = { ids: allIds.slice(0, 3), found: 3 };
  assert.equal(
    verdict({
      contract,
      row: row({ conditions: { pipeline: condition(threeDefects) } }),
      baselineRow: baseline({
        conditions: { pipeline: condition(threeDefects) },
      }),
    }).verdict,
    "GREEN",
  );
});

test("a pipeline gain replay does not corroborate does not re-anchor", () => {
  // A PROMOTE moves the baseline every later run is paired against, and since
  // ADR 0090 `pipeline` takes one live finder draw per PR, so six net flips
  // there can be the draw. `replay` replays frozen reports over the grid, so
  // it is the condition that can tell the two apart.
  const gain = { pipeline: condition({ found: 26 }) };
  const base = { pipeline: condition({ found: 20 }) };
  const cases = [
    {
      name: "replay held still",
      row: row({ conditions: { ...gain, replay: replay({ found: 10 }) } }),
      baseline: baseline({
        conditions: { ...base, replay: replay({ found: 10 }) },
      }),
      reason:
        /replay moved 0 defects on 39 shared defects, and corroboration needs a net gain of at least 3/,
    },
    {
      name: "replay moved the other way",
      row: row({ conditions: { ...gain, replay: replay({ found: 8 }) } }),
      baseline: baseline({
        conditions: { ...base, replay: replay({ found: 10 }) },
      }),
      reason: /replay moved -2 defects/,
    },
    {
      name: "replay gained less than the corroboration threshold",
      row: row({ conditions: { ...gain, replay: replay({ found: 12 }) } }),
      baseline: baseline({
        conditions: { ...base, replay: replay({ found: 10 }) },
      }),
      reason: /replay moved 2 defects/,
    },
    {
      name: "replay absent on the row",
      row: row({ conditions: gain }),
      baseline: baseline({
        conditions: { ...base, replay: replay({ found: 10 }) },
      }),
      reason: /replay is absent on this row/,
    },
    {
      name: "replay absent on the baseline",
      row: row({ conditions: { ...gain, replay: replay({ found: 13 }) } }),
      baseline: baseline({ conditions: base }),
      reason: /replay is absent on the baseline/,
    },
    {
      name: "replay shares fewer defects than the noise floor",
      row: row({
        conditions: {
          ...gain,
          replay: condition({ ids: gridIds.slice(0, 2), found: 2 }),
        },
      }),
      baseline: baseline({
        conditions: {
          ...base,
          replay: condition({ ids: gridIds.slice(0, 2), found: 0 }),
        },
      }),
      reason:
        /replay and the baseline share only 2 scored defect\(s\); noise_floor_defects 3 refuses to corroborate/,
    },
  ];
  for (const item of cases) {
    const decision = verdict({
      contract,
      row: item.row,
      baselineRow: item.baseline,
    });
    assert.equal(decision.verdict, "GREEN", item.name);
    const joined = decision.reasons.join("\n");
    // The gain is still stated: the reader sees what moved and why it is not
    // enough to move the anchor.
    assert.match(joined, /pipeline gained a net 6 defects/, item.name);
    assert.match(joined, item.reason, `${item.name}: ${joined}`);
    assert.match(joined, /does not re-anchor the baseline/, item.name);
  }
});

test("corroboration gates PROMOTE only, and only a pipeline headline", () => {
  // RED is unchanged: a spurious RED costs an investigation, a spurious
  // PROMOTE silently moves the reference.
  const red = verdict({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 14 }) } }),
    baselineRow: baseline({
      conditions: { pipeline: condition({ found: 20 }) },
    }),
  });
  assert.equal(red.verdict, "RED", JSON.stringify(red.reasons));
  assert.match(red.reasons.join("\n"), /lost a net 6 defects/);
  // A row whose headline is `replay` scored no live pipeline cell, and
  // `replay`'s finder is frozen, so there is no finder sampling to corroborate.
  const replayHeadline = verdict({
    contract,
    row: row({ conditions: { replay: replay({ found: 26 }) } }),
    baselineRow: baseline({ conditions: { replay: replay({ found: 20 }) } }),
  });
  assert.equal(
    replayHeadline.verdict,
    "PROMOTE",
    JSON.stringify(replayHeadline.reasons),
  );
  assert.match(replayHeadline.reasons.join("\n"), /replay gained a net 6/);
});

test("the gate binds the contracts that pre-register it", () => {
  // A contract from before this rule never registered it, and
  // `--report --contract <archived>` has to reproduce the verdict that run
  // saw, so an absent key leaves the PROMOTE standing. A key the gate cannot
  // read is the other case: the contract claims the gate and cannot run it.
  const gain = row({
    conditions: {
      pipeline: condition({ found: 26 }),
      replay: replay({ found: 16 }),
    },
  });
  const base = baseline({
    conditions: {
      pipeline: condition({ found: 20 }),
      replay: replay({ found: 10 }),
    },
  });
  const corroborated = verdict({ contract, row: gain, baselineRow: base });
  assert.equal(
    corroborated.verdict,
    "PROMOTE",
    JSON.stringify(corroborated.reasons),
  );
  // An archived contract: the rule is absent, so the old verdict stands even
  // when replay would not corroborate.
  const archived = structuredClone(contract);
  delete archived.verdict_rules.promote_corroboration_net_flips;
  const flatReplay = {
    pipeline: condition({ found: 26 }),
    replay: replay({ found: 10 }),
  };
  const legacy = verdict({
    contract: archived,
    row: row({ conditions: flatReplay }),
    baselineRow: base,
  });
  assert.equal(legacy.verdict, "PROMOTE", JSON.stringify(legacy.reasons));
  // A value the gate cannot read corroborates nothing.
  for (const value of [0, -3, "3", null]) {
    const broken = structuredClone(contract);
    broken.verdict_rules.promote_corroboration_net_flips = value;
    const decision = verdict({
      contract: broken,
      row: row({ conditions: flatReplay }),
      baselineRow: base,
    });
    assert.equal(decision.verdict, "GREEN", String(value));
    assert.match(
      decision.reasons.join("\n"),
      /which the gate cannot read, so nothing corroborates the pipeline gain/,
      String(value),
    );
  }
  const noFloor = structuredClone(contract);
  delete noFloor.verdict_rules.noise_floor_defects;
  assert.equal(
    verdict({
      contract: noFloor,
      row: row({ conditions: flatReplay }),
      baselineRow: base,
    }).verdict,
    "GREEN",
  );
});

test("a condition that scored no P1 defect is not read as zero P1 recall", () => {
  const noP1 = row({
    conditions: {
      pipeline: condition({
        found: 20,
        p1: { matched: 0, opportunities: 0, rate: null },
      }),
    },
  });
  const decision = verdict({ contract, row: noP1 });
  assert.equal(decision.verdict, "GREEN");
  assert.match(
    decision.reasons.join("\n"),
    /scored no P1 defect, so the p1_recall_floor check is skipped/,
  );
  assert.match(renderReport({ contract, row: noP1, truth }), /0\/0 \(n\/a\)/);
});

test("a bridge row may cross comparability keys", () => {
  const decision = verdict({
    contract,
    row: row({ kind: "bridge" }),
    baselineRow: baseline({ comparability_key: OTHER_KEY }),
  });
  assert.equal(decision.verdict, "GREEN");
  assert.ok(
    decision.reasons.some((reason) => /bridge row/.test(reason)),
    JSON.stringify(decision.reasons),
  );
});

test("canary rows only pass or fail, and never rank", () => {
  const canary = (found, overrides = {}) =>
    row({
      kind: "canary",
      conditions: {
        replay: condition({
          ids: gridIds,
          found,
          draws: 1,
          p1Matched: 4,
          p1Opportunities: 6,
          ...overrides,
        }),
      },
    });
  // A canary scores the grid in one draw, so the floor has to sit inside the
  // grid's own opportunities and a row that reaches it passes.
  const floor = rules.canary_min_matched_grid;
  assert.equal(floor <= gridIds.length, true);
  assert.equal(
    verdict({ contract, row: canary(floor), baselineRow: baseline() }).verdict,
    "GREEN",
  );
  const low = verdict({ contract, row: canary(floor - 1) });
  assert.equal(low.verdict, "RED");
  assert.match(
    low.reasons[0],
    new RegExp(`below canary_min_matched_grid ${floor}`),
  );
  const silent = verdict({
    contract,
    row: canary(floor, { zero_finding_prs: 1 }),
  });
  assert.equal(silent.verdict, "RED");
  assert.match(silent.reasons[0], /no parseable finding on 1 PR/);
  // A big paired gain still never promotes a canary.
  assert.equal(
    verdict({
      contract,
      row: canary(gridIds.length),
      baselineRow: baseline(),
    }).verdict,
    "GREEN",
  );
  assert.equal(
    verdict({ contract, row: { ...canary(floor), status: "partial" } }).verdict,
    "INCOMPLETE",
  );
});

test("a judge below its calibration floor gates every score verdict", () => {
  const drifted = { agreement: 33, total: 40 };
  // The judge produced the matched ids, so a floor breach it reported is not
  // evidence either. The run is AMBER and unusable, never RED and never GREEN.
  const belowP1 = verdict({
    contract,
    row: row({
      judge_calibration: drifted,
      conditions: {
        pipeline: condition({ found: 20, p1Matched: 7, p1Opportunities: 12 }),
      },
    }),
    baselineRow: baseline(),
  });
  assert.equal(belowP1.verdict, "AMBER");
  assert.ok(
    belowP1.reasons.some((reason) => /below 37\/40/.test(reason)),
    belowP1.reasons.join(" | "),
  );
  assert.ok(!belowP1.reasons.some((reason) => /p1_recall_floor/.test(reason)));

  // A paired gain that would otherwise promote is held at AMBER too.
  assert.equal(
    verdict({
      contract,
      row: row({
        judge_calibration: drifted,
        conditions: { pipeline: condition({ found: 26 }) },
      }),
      baselineRow: baseline(),
    }).verdict,
    "AMBER",
  );

  // A canary is a floor test read by the same judge.
  const canary = verdict({
    contract,
    row: row({
      kind: "canary",
      judge_calibration: drifted,
      conditions: {
        replay: condition({
          ids: gridIds,
          found: 8,
          draws: 1,
          p1Matched: 4,
          p1Opportunities: 6,
        }),
      },
    }),
  });
  assert.equal(canary.verdict, "AMBER");
  assert.match(canary.reasons[0], /below 37\/40/);

  // A failed run is still INCOMPLETE: it has no matrix for a judge to read.
  assert.equal(
    verdict({
      contract,
      row: row({
        status: "failed",
        judge_calibration: { agreement: 0, total: 1 },
        notes: "codex CLI unauthenticated",
      }),
    }).verdict,
    "INCOMPLETE",
  );
});

test("a regression the control moved with is AMBER, not RED", () => {
  const moved = {
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ found: 4, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ found: 10, draws: 1 }),
      },
    }),
  };
  // Six net flips is the RED line, and the control fell by six as well: the
  // model moved with the pipeline, so the loss is not attributable to the
  // skill. The attribution check has to run before RED is returned, not after.
  const decision = verdict({ contract, ...moved });
  assert.equal(decision.verdict, "AMBER");
  assert.ok(
    decision.reasons.some((reason) => /control moved/.test(reason)),
    decision.reasons.join(" | "),
  );
  assert.ok(
    decision.reasons.some((reason) => /lost a net 6 defects/.test(reason)),
    decision.reasons.join(" | "),
  );

  // The same regression with a steady control stays RED.
  const steady = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ found: 10, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ found: 10, draws: 1 }),
      },
    }),
  });
  assert.equal(steady.verdict, "RED");

  // An absolute floor is a floor whatever the control did.
  assert.equal(
    verdict({
      contract,
      row: row({
        conditions: {
          pipeline: condition({ found: 14, p1Matched: 7, p1Opportunities: 12 }),
          control: condition({ found: 4, draws: 1 }),
        },
      }),
      baselineRow: moved.baselineRow,
    }).verdict,
    "RED",
  );
});

test("two rows of one key with unequal draws do not pair", () => {
  // One comparability key means one planner, so two rows under it planned the
  // same draws. When they disagree, one did not come from that planner, and
  // `perDefectBits` folds a condition's draws with OR: the side with the extra
  // draw carries the higher hit rate for no reason the skill accounts for.
  const pairing = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: condition({ found: 14, draws: 1 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20, draws: 2 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
  });
  assert.ok(
    pairing.reasons.some((reason) =>
      /baseline pipeline carries 2 draw\(s\) against this row's 1 under one comparability_key/.test(
        reason,
      ),
    ),
    pairing.reasons.join(" | "),
  );
  // Refused as a pairing means refused as a ranking: no flip count survives to
  // call this RED or PROMOTE.
  assert.ok(
    ["AMBER", "GREEN"].includes(pairing.verdict),
    `${pairing.verdict}: ${pairing.reasons.join(" | ")}`,
  );
});

/** A condition whose found ids are given outright, for a split-direction row. */
function splitCondition({ ids, foundIds, draws = 2, ...overrides }) {
  const found = new Set(foundIds);
  return condition({
    ids,
    draws,
    per_defect: Object.fromEntries(
      ids.map((id) => [
        id,
        Array.from({ length: draws }, () => (found.has(id) ? 1 : 0)),
      ]),
    ),
    ...overrides,
  });
}

test("the drift waiver points the way the regression it waives points", () => {
  // Since ADR 0090 `control` runs the grid alone while `pipeline` covers every
  // fixture, so the two conditions no longer score the same defects.
  const gridScope = new Set(gridIds);
  const nonGridIds = allIds.filter((id) => !gridScope.has(id));
  assert.ok(nonGridIds.length > 5, "the contract needs non-grid defects");

  // The headline's whole loss sits on the grid, where control lost with it.
  // The reason names how much of that movement control was able to see.
  const movedTogether = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ ids: gridIds, found: 4, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
  });
  assert.equal(movedTogether.verdict, "AMBER");
  assert.ok(
    movedTogether.reasons.some((reason) =>
      new RegExp(
        `control moved 6 defects in the same direction as the headline, which moved 6 on the ${gridIds.length} defect\\(s\\) control also scored`,
      ).test(reason),
    ),
    movedTogether.reasons.join(" | "),
  );

  // A control that moved the other way explains nothing, and the RED stands.
  const opposed = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ ids: gridIds, found: 4, draws: 1 }),
      },
    }),
  });
  assert.equal(opposed.verdict, "RED");

  // The case the grid slice alone gets wrong. The headline gains six defects on
  // the grid and loses twelve off it: a net loss of six, which is the RED line.
  // Control, on the grid, gains six with it. Keyed to the grid the two look
  // like one movement and the waiver fires; keyed to the regression it waives
  // — a net loss over every defect the headline scored — control is moving the
  // other way and explains none of it.
  const gridGain = gridIds.slice(0, 16);
  const baselineGrid = gridIds.slice(0, 10);
  const split = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: splitCondition({ ids: allIds, foundIds: gridGain }),
        control: splitCondition({
          ids: gridIds,
          foundIds: gridGain,
          draws: 1,
        }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: splitCondition({
          ids: allIds,
          foundIds: [...baselineGrid, ...nonGridIds],
        }),
        control: splitCondition({
          ids: gridIds,
          foundIds: baselineGrid,
          draws: 1,
        }),
      },
    }),
  });
  assert.equal(
    split.verdict,
    "RED",
    `${split.verdict}: ${split.reasons.join(" | ")}`,
  );
  assert.ok(
    !split.reasons.some((reason) => /control moved/.test(reason)),
    split.reasons.join(" | "),
  );
});

test("the drift waiver is scaled to the 39 grid defects control scores", () => {
  // Control scores the 39 grid defects of the 51 the headline scores, so drift
  // spread evenly over the suite reaches six flips on the headline and five on
  // control. Under the headline's own `regression_net_flips` that was a RED the
  // control could not waive; `control_waiver_net_flips` asks control for its
  // share of the same movement. ADR 0094.
  const scaled = {
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ ids: gridIds, found: 5, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
  };
  assert.equal(rules.control_waiver_net_flips, 5);
  const waived = verdict({ contract, ...scaled });
  assert.equal(waived.verdict, "AMBER", waived.reasons.join(" | "));
  assert.ok(
    waived.reasons.some((reason) =>
      /control moved 5 defects in the same direction .*control_waiver_net_flips 5/.test(
        reason,
      ),
    ),
    waived.reasons.join(" | "),
  );

  // One flip below the scaled threshold still explains nothing.
  const short = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: condition({ found: 14 }),
        control: condition({ ids: gridIds, found: 6, draws: 1 }),
      },
    }),
    baselineRow: scaled.baselineRow,
  });
  assert.equal(short.verdict, "RED", short.reasons.join(" | "));

  // An archived contract never registered the key, and `--report --contract`
  // has to reproduce the verdict that run saw: the old threshold stands, so
  // five flips do not waive.
  const archived = structuredClone(contract);
  delete archived.verdict_rules.control_waiver_net_flips;
  assert.equal(verdict({ contract: archived, ...scaled }).verdict, "RED");

  // A contract that claims the scaled waiver and gives it a value the gate
  // cannot read waives nothing.
  for (const value of [0, -5, "5", null]) {
    const broken = structuredClone(contract);
    broken.verdict_rules.control_waiver_net_flips = value;
    assert.equal(
      verdict({ contract: broken, ...scaled }).verdict,
      "RED",
      String(value),
    );
  }
});

test("the drift waiver refuses when the headline gained on control's scope", () => {
  // Control and the headline can both fall overall and still fall on disjoint
  // defects. Here the headline loses eleven non-grid defects and gains five on
  // the grid: a net loss of six, the RED line. Control loses five on the grid,
  // which clears the scaled threshold and points the same way as the headline's
  // net loss. On the 39 defects control actually scored the headline moved the
  // other way, so control's drift explains none of the loss it would waive.
  const gridScope = new Set(gridIds);
  const nonGridIds = allIds.filter((id) => !gridScope.has(id));
  const offGrid = verdict({
    contract,
    row: row({
      conditions: {
        pipeline: splitCondition({
          ids: allIds,
          foundIds: [nonGridIds[0], ...gridIds.slice(0, 15)],
        }),
        control: splitCondition({
          ids: gridIds,
          foundIds: gridIds.slice(0, 5),
          draws: 1,
        }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: splitCondition({
          ids: allIds,
          foundIds: [
            ...nonGridIds,
            ...gridIds.slice(0, 5),
            ...gridIds.slice(10, 15),
          ],
        }),
        control: splitCondition({
          ids: gridIds,
          foundIds: gridIds.slice(0, 10),
          draws: 1,
        }),
      },
    }),
  });
  assert.equal(
    offGrid.verdict,
    "RED",
    `${offGrid.verdict}: ${offGrid.reasons.join(" | ")}`,
  );
  assert.ok(
    !offGrid.reasons.some((reason) => /control moved/.test(reason)),
    offGrid.reasons.join(" | "),
  );
});

test("control drift at the scaled threshold takes a gain row off the ranking", () => {
  // The waiver is not only a RED softener. `worldMoved` pushes AMBER whichever
  // way the run moved, so scaling the threshold down to control's own scope
  // also widens the set of gain rows that lose their rankability. Here the
  // headline gains one defect, well inside the noise floor, and control gains
  // five on the grid. ADR 0094 records the widening.
  const gainRow = {
    row: row({
      conditions: {
        pipeline: condition({ found: 21 }),
        control: condition({ ids: gridIds, found: 10, draws: 1 }),
      },
    }),
    baselineRow: baseline({
      conditions: {
        pipeline: condition({ found: 20 }),
        control: condition({ ids: gridIds, found: 5, draws: 1 }),
      },
    }),
  };
  const drifted = verdict({ contract, ...gainRow });
  assert.equal(drifted.verdict, "AMBER", drifted.reasons.join(" | "));
  assert.ok(
    drifted.reasons.some((reason) =>
      /control moved -5 defects in the same direction .*control_waiver_net_flips 5/.test(
        reason,
      ),
    ),
    drifted.reasons.join(" | "),
  );

  // Under the pre-ADR 0094 threshold the same drift left the row rankable.
  const archived = structuredClone(contract);
  delete archived.verdict_rules.control_waiver_net_flips;
  assert.equal(
    verdict({ contract: archived, ...gainRow }).verdict,
    "GREEN",
    "the old threshold left a five-flip control drift alone",
  );
});

test("the report states the verdict, the table, and the defects that flipped", () => {
  const candidate = row({
    verdict: "RED",
    conditions: {
      pipeline: condition({ found: 14 }),
      replay: condition({
        ids: gridIds,
        found: 8,
        p1Matched: 4,
        p1Opportunities: 6,
      }),
      control: condition({ found: 6, draws: 1, finder: undefined }),
    },
  });
  const report = renderReport({
    contract,
    row: candidate,
    baselineRow: baseline(),
    truth,
  });
  const lines = report.split("\n");
  assert.ok(
    lines.length <= REPORT_MAX_LINES + 1,
    `report is ${lines.length} lines:\n${report}`,
  );
  assert.match(report, /## Review-skill eval — 2026-12-08 \(full\)/);
  assert.match(report, /\*\*RED\*\*/);
  assert.match(
    report,
    /\| pipeline \| gpt-5\.6-sol@high → claude-opus-5@high \| 2 \|/,
  );
  assert.match(report, /\| control \| claude-opus-5@high \| 1 \|/);
  assert.match(report, /McNemar vs 2026-09-08 on `pipeline`: b=6 c=0 delta=6/);
  assert.match(report, /Judge calibration 40\/40\./);
  assert.match(
    report,
    /Detail: `docs\/evals\/review-skill-runs\/2026-12-08-3f9c1a58`/,
  );
  // Flip lines resolve the frozen defect id to its truth path, line, and title.
  assert.ok(truth.has(String(allIds[14])), "expected the flipped id in truth");
  const record = truth.get(String(allIds[14]));
  assert.ok(
    report.includes(`- lost \`${allIds[14]}\` ${record.path}:${record.line}`),
    `expected a resolved flip line for ${allIds[14]}:\n${report}`,
  );
});

test("the report separates cell dollars from what the judges cost", () => {
  const cells = renderReport({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 20, usd: 60 }) } }),
    truth,
  });
  // A row written before the field existed still totals what it does carry.
  assert.match(
    cells,
    /Cost \$60\.00 over \d+ s — \$60\.00 cells, \$0\.00 scoring\./,
  );

  const scored = renderReport({
    contract,
    row: row({
      conditions: { pipeline: condition({ found: 20, usd: 60 }) },
      scoring_usd: 12.5,
    }),
    truth,
  });
  assert.match(
    scored,
    /Cost \$72\.50 over \d+ s — \$60\.00 cells, \$12\.50 scoring\./,
  );
});

test("the generated staleness issue runs one CLI mode per command", () => {
  const payload = scheduleIssuePayload({
    freshnessResult: freshness({
      rows: [],
      contract,
      now: new Date("2026-12-20T00:00:00Z"),
      contractDigest: CONTRACT_DIGEST,
    }),
    contract,
    contractDigest: CONTRACT_DIGEST,
  });
  // The CLI refuses two modes in one invocation, so a combined line would fail
  // the acceptance check for every operator who pasted the block.
  assert.match(payload.body, /pnpm review:eval -- --check-fixtures\n/);
  assert.match(payload.body, /pnpm review:eval -- --check-ledger\n/);
  assert.doesNotMatch(payload.body, /--check-fixtures --check-ledger/);
});

test("the report prints the row's verdict and flags a recomputed disagreement", () => {
  const lost = { pipeline: condition({ found: 14 }) };
  const mislabelled = renderReport({
    contract,
    row: row({ verdict: "GREEN", conditions: lost }),
    baselineRow: baseline(),
    truth,
  });
  // The row is the artifact of record, so its own verdict is what is printed.
  assert.match(mislabelled, /\*\*GREEN\*\*/);
  assert.match(
    mislabelled,
    /stored verdict GREEN disagrees with the verdict recomputed here \(RED\)/,
  );
  const honest = renderReport({
    contract,
    row: row({ verdict: "RED", conditions: lost }),
    baselineRow: baseline(),
    truth,
  });
  assert.match(honest, /\*\*RED\*\*/);
  assert.doesNotMatch(honest, /disagrees/);
});

test("the report survives a run with no baseline and truncates a long flip list", () => {
  const solo = renderReport({ contract, row: row(), truth });
  assert.match(solo, /No paired baseline comparison for this row\./);
  assert.match(solo, /\*\*GREEN\*\*/);

  const churned = renderReport({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 0 }) } }),
    baselineRow: baseline({
      conditions: { pipeline: condition({ found: 34 }) },
    }),
    truth,
  });
  assert.ok(
    churned.split("\n").length <= REPORT_MAX_LINES + 1,
    `report is too long:\n${churned}`,
  );
  assert.match(churned, /more flips|truncated at 40 lines/);
});

test("the report resolves truth titles from the committed truth files", () => {
  const withFiles = renderReport({
    contract,
    row: row({ conditions: { pipeline: condition({ found: 14 }) } }),
    baselineRow: baseline(),
    repoRoot,
  });
  const record = truth.get(String(allIds[14]));
  assert.ok(withFiles.includes(`${record.path}:${record.line}`), withFiles);
});

test("scheduleIssuePayload stays silent while the ledger is fresh", () => {
  const fresh = freshness({
    rows: [{ ...row(), executed_at: "2026-12-08T10:41:07Z" }],
    contract,
    now: new Date("2026-12-20T00:00:00Z"),
    contractDigest: CONTRACT_DIGEST,
  });
  assert.equal(fresh.level, "green");
  assert.equal(
    scheduleIssuePayload({ freshnessResult: fresh, contract }),
    null,
  );
});

test("scheduleIssuePayload dedups on the contract digest and the month", () => {
  const stale = freshness({
    rows: [{ ...row(), executed_at: "2026-09-08T10:41:07Z" }],
    contract,
    now: new Date("2026-12-20T00:00:00Z"),
    contractDigest: CONTRACT_DIGEST,
  });
  assert.equal(stale.level, "red");
  const payload = scheduleIssuePayload({ freshnessResult: stale, contract });
  assert.equal(
    payload.title,
    "Review-skill eval is stale (last full run 2026-09-08)",
  );
  assert.deepEqual(payload.labels, REVIEW_EVAL_ISSUE_LABELS);
  assert.ok(payload.labels.includes("source:audit"));
  const [first, second] = payload.body.split("\n");
  assert.equal(first, REVIEW_EVAL_MARKER);
  assert.equal(second, reviewEvalMonthMarker("2026-12", CONTRACT_DIGEST));
  assert.deepEqual(parseLeadingReviewEvalMarkers(payload.body), {
    month: "2026-12",
    contract_digest: CONTRACT_DIGEST,
  });
  assert.match(
    payload.body,
    /no full run in 103 days \(full_red 120\)|freshness_red 60/,
  );
  assert.match(payload.body, /pnpm review:eval:run/);

  const never = scheduleIssuePayload({
    freshnessResult: freshness({
      rows: [],
      contract,
      now: new Date("2026-12-20T00:00:00Z"),
      contractDigest: CONTRACT_DIGEST,
    }),
    contract,
  });
  assert.equal(never.title, "Review-skill eval is stale (last full run never)");
});

test("the staleness marker refuses metadata it cannot dedup on", () => {
  assert.throws(
    () => reviewEvalMonthMarker("2026-13-01", CONTRACT_DIGEST),
    /invalid month/,
  );
  assert.throws(
    () => reviewEvalMonthMarker("2026-12", "short"),
    /contract digest/,
  );
  assert.equal(parseLeadingReviewEvalMarkers("unrelated body"), null);
  assert.throws(
    () => parseLeadingReviewEvalMarkers(`${REVIEW_EVAL_MARKER}\nnot a marker`),
    /malformed month marker/,
  );
  assert.throws(
    () =>
      scheduleIssuePayload({
        freshnessResult: freshness({
          rows: [],
          contract,
          now: new Date("2026-12-20T00:00:00Z"),
        }),
        contract,
      }),
    /needs the current contract digest/,
  );
});

test("headlineCondition prefers the live pipeline", () => {
  assert.equal(headlineCondition(row()).name, "pipeline");
  assert.equal(
    headlineCondition({
      conditions: { control: condition(), replay: condition() },
    }).name,
    "replay",
  );
  assert.equal(headlineCondition({ conditions: {} }).name, null);
});
