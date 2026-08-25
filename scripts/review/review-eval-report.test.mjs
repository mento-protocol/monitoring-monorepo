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
    executed_at: "2026-12-08T10:41:07.000Z",
    status: "complete",
    verdict: "GREEN",
    comparability_key: KEY,
    contract_digest: CONTRACT_DIGEST,
    inputs: {
      skill_digest: "d".repeat(64),
      skill_ref: "origin/main",
      codex_review_sh_digest: "e".repeat(64),
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
    executed_at: "2026-09-08T10:41:07.000Z",
    detail_dir: "docs/evals/review-skill-runs/2026-09-08-3f9c1a58",
    ...overrides,
  });
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
      name: "AMBER on judge drift",
      row: row({ judge_calibration: { agreement: 37, total: 40 } }),
      baseline: baseline(),
      expect: "AMBER",
      reason: /below 38\/40/,
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
      name: "PROMOTE on a net gain past the threshold",
      row: row({ conditions: { pipeline: condition({ found: 26 }) } }),
      baseline: baseline(),
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
  assert.equal(
    verdict({ contract, row: canary(10), baselineRow: baseline() }).verdict,
    "GREEN",
  );
  const low = verdict({ contract, row: canary(8) });
  assert.equal(low.verdict, "RED");
  assert.match(low.reasons[0], /below canary_min_matched_grid 9/);
  const silent = verdict({
    contract,
    row: canary(10, { zero_finding_prs: 1 }),
  });
  assert.equal(silent.verdict, "RED");
  assert.match(silent.reasons[0], /no parseable finding on 1 PR/);
  // A big paired gain still never promotes a canary.
  assert.equal(
    verdict({
      contract,
      row: canary(rules.canary_min_matched_grid + 11),
      baselineRow: baseline(),
    }).verdict,
    "GREEN",
  );
  assert.equal(
    verdict({ contract, row: { ...canary(10), status: "partial" } }).verdict,
    "INCOMPLETE",
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
    rows: [{ ...row(), executed_at: "2026-12-08T10:41:07.000Z" }],
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
    rows: [{ ...row(), executed_at: "2026-09-08T10:41:07.000Z" }],
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
