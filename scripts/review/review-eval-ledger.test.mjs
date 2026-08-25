#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendRow,
  checkLedger,
  compareLedgers,
  CONDITION_NAMES,
  CONDITION_OPTIONAL_KEYS,
  CONDITION_REQUIRED_KEYS,
  contractScorableIds,
  freshness,
  INPUTS_OPTIONAL_KEYS,
  INPUTS_REQUIRED_KEYS,
  LEDGER_KINDS,
  LEDGER_STATUSES,
  LEDGER_VERDICTS,
  readLedger,
  ROW_OPTIONAL_KEYS,
  ROW_REQUIRED_KEYS,
  validateLedgerRow,
} from "./review-eval-ledger.mjs";
import { aggregateDraws } from "./review-eval-score.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
    "utf8",
  ),
);
const schema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs/evals/review-skill-result.schema.json"),
    "utf8",
  ),
);

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const MS_PER_DAY = 86_400_000;
const NOW = new Date("2026-12-01T00:00:00.000Z");
const scorable = [...contractScorableIds(contract)];

function daysAgo(days, from = NOW) {
  return new Date(from.valueOf() - days * MS_PER_DAY).toISOString();
}

function condition(overrides = {}) {
  const perDefect = overrides.per_defect ?? {
    [scorable[0]]: [1, 1],
    [scorable[1]]: [1, 0],
    [scorable[2]]: [0, 0],
  };
  const draws = overrides.draws ?? 2;
  const ids = Object.keys(perDefect);
  const matched = ids.reduce(
    (sum, id) => sum + perDefect[id].filter((bit) => bit === 1).length,
    0,
  );
  const opportunities = ids.length * draws;
  return {
    model: "claude-opus-5",
    effort: "high",
    draws,
    recall: {
      matched,
      opportunities,
      rate:
        opportunities === 0 ? 0 : Number((matched / opportunities).toFixed(3)),
    },
    p1: { matched: 2, opportunities: 2, rate: 1 },
    novel_real: 3,
    wrong_claims: 1,
    usd: 12.5,
    seconds: 900,
    per_defect: perDefect,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    schema_version: 1,
    kind: "full",
    executed_at: daysAgo(1),
    status: "complete",
    verdict: "GREEN",
    comparability_key: "c".repeat(64),
    contract_digest: DIGEST_A,
    inputs: {
      skill_digest: "d".repeat(64),
      skill_ref: "origin/main",
      codex_review_sh_digest: "e".repeat(64),
      claude_cli: "2.1.14",
      codex_cli: "0.48.2",
      host: "chapati-mbp",
    },
    conditions: { pipeline: condition() },
    judge_calibration: { agreement: 40, total: 40 },
    vs_baseline: null,
    detail_dir: "docs/evals/review-skill-runs/2026-11-30-3f9c1a58",
    notes: "",
    ...overrides,
  };
}

function withTempLedger(contents, body) {
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-ledger-"));
  try {
    const file = path.join(dir, "review-skill-ledger.jsonl");
    writeFileSync(file, contents);
    return body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonl(...rows) {
  return rows.map((item) => `${JSON.stringify(item)}\n`).join("");
}

test("the structural validator carries the same fields as the committed schema", () => {
  assert.deepEqual(schema.required, ROW_REQUIRED_KEYS);
  assert.deepEqual(Object.keys(schema.properties), [
    ...ROW_REQUIRED_KEYS,
    ...ROW_OPTIONAL_KEYS,
  ]);
  assert.deepEqual(schema.properties.kind.enum, LEDGER_KINDS);
  assert.deepEqual(schema.properties.status.enum, LEDGER_STATUSES);
  assert.deepEqual(schema.properties.verdict.enum, LEDGER_VERDICTS);
  assert.deepEqual(schema.properties.inputs.required, INPUTS_REQUIRED_KEYS);
  assert.deepEqual(Object.keys(schema.properties.inputs.properties), [
    ...INPUTS_REQUIRED_KEYS,
    ...INPUTS_OPTIONAL_KEYS,
  ]);
  assert.deepEqual(
    Object.keys(schema.properties.conditions.properties),
    CONDITION_NAMES,
  );
  assert.deepEqual(schema.$defs.condition.required, CONDITION_REQUIRED_KEYS);
  assert.deepEqual(
    Object.keys(schema.$defs.condition.properties).filter(
      (key) => !CONDITION_REQUIRED_KEYS.includes(key),
    ),
    CONDITION_OPTIONAL_KEYS,
  );
});

test("a well-formed row validates", () => {
  assert.deepEqual(validateLedgerRow(row()), []);
  assert.deepEqual(
    validateLedgerRow(
      row({
        kind: "bridge",
        conditions: {
          pipeline: condition(),
          replay: condition({
            draws: 1,
            per_defect: { [scorable[0]]: [1] },
            p1: { matched: 1, opportunities: 1, rate: 1 },
          }),
          control: condition({ finder: "none", zero_finding_prs: 1 }),
        },
        vs_baseline: {
          baseline_executed_at: daysAgo(90),
          mcnemar: { b: 3, c: 1, delta: 2 },
          control_mcnemar: { b: 0, c: 0, delta: 0 },
          baseline_comparability_key: "f".repeat(64),
        },
      }),
    ),
    [],
  );
});

test("the no-opportunity rate the producers emit is a valid row", () => {
  // `aggregateDraws` emits `rate: null` for a bucket with no opportunities,
  // and `verdict()` reads that null as "not measured" and skips the
  // p1_recall_floor check. A 0 there would read as measured zero recall, so
  // the validator has to accept the sentinel rather than force the producers
  // to lie. It is legal only at zero opportunities.
  const aggregate = aggregateDraws({
    scorableIds: [Number(scorable[0])],
    p1Ids: [],
    draws: [[Number(scorable[0])]],
  });
  assert.deepEqual(aggregate.p1, { matched: 0, opportunities: 0, rate: null });
  assert.deepEqual(
    validateLedgerRow(
      row({
        conditions: {
          pipeline: condition({
            draws: 1,
            per_defect: { [scorable[0]]: [1] },
            recall: { matched: 1, opportunities: 1, rate: 1 },
            p1: aggregate.p1,
          }),
        },
      }),
    ),
    [],
  );
  assert.ok(
    validateLedgerRow(
      row({
        conditions: {
          pipeline: condition({
            draws: 1,
            per_defect: { [scorable[0]]: [1] },
            recall: { matched: 1, opportunities: 1, rate: null },
            p1: { matched: 0, opportunities: 0, rate: null },
          }),
        },
      }),
    ).some((problem) =>
      /recall\.rate may be null only when .*opportunities is 0/.test(problem),
    ),
  );
});

test("row validation rejects each contract violation", () => {
  const cases = [
    [row({ schema_version: 2 }), /schema_version/],
    [row({ kind: "smoke" }), /kind must be one of/],
    [row({ status: "green" }), /status must be one of/],
    [row({ verdict: "green" }), /verdict must be one of/],
    [row({ executed_at: "last tuesday" }), /executed_at must be an ISO/],
    [row({ contract_digest: "abc" }), /contract_digest must be a lowercase/],
    [row({ extra: 1 }), /unexpected property extra/],
    [row({ conditions: {} }), /at least one condition/],
    [
      row({ conditions: { pipeline: condition({ draws: 1 }) } }),
      /has 2 bits for 1 draws/,
    ],
    [
      row({
        conditions: {
          pipeline: condition({
            recall: { matched: 9, opportunities: 6, rate: 1.5 },
          }),
        },
      }),
      /matched exceeds/,
    ],
    [
      row({
        conditions: {
          pipeline: condition({
            recall: { matched: 3, opportunities: 6, rate: 0.9 },
          }),
        },
      }),
      /does not match 3\/6/,
    ],
    [
      row({
        conditions: {
          pipeline: condition({ per_defect: { [scorable[0]]: [1, 2] } }),
        },
      }),
      /must contain only 0 or 1/,
    ],
    [row({ judge_calibration: { agreement: 41, total: 40 } }), /exceeds total/],
    [
      row({
        vs_baseline: {
          baseline_executed_at: daysAgo(90),
          mcnemar: { b: 3, c: 1, delta: 9 },
        },
      }),
      /delta must equal b - c/,
    ],
  ];
  for (const [candidate, pattern] of cases) {
    const problems = validateLedgerRow(candidate);
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `expected ${pattern} in ${JSON.stringify(problems)}`,
    );
  }
});

test("a defect whose PR ran fewer draws keeps a shorter bit vector", () => {
  const problems = validateLedgerRow(
    row({
      conditions: {
        pipeline: condition({
          draws: 2,
          // The third defect belongs to a PR whose draw-2 cell never ran, so it
          // carries one bit. A second bit there would be a miss it never had
          // the chance to avoid.
          per_defect: {
            [scorable[0]]: [1, 1],
            [scorable[1]]: [1, 0],
            [scorable[2]]: [0],
          },
          recall: { matched: 3, opportunities: 5, rate: 0.6 },
        }),
      },
    }),
  );
  assert.deepEqual(problems, []);
});

test("an empty ledger reads as no rows and a malformed ledger names its line", () => {
  withTempLedger("", (file) => assert.deepEqual(readLedger(file), []));
  withTempLedger(`${jsonl(row())}{"broken"\n`, (file) => {
    assert.throws(() => readLedger(file), /line 2 is not valid JSON/);
  });
  withTempLedger(`${jsonl(row())}\n${jsonl(row())}`, (file) => {
    assert.throws(() => readLedger(file), /line 2 is blank/);
  });
});

test("appendRow appends validated rows and refuses invalid ones", () => {
  withTempLedger("", (file) => {
    appendRow(file, row({ executed_at: daysAgo(3) }));
    appendRow(file, row({ executed_at: daysAgo(2) }));
    const rows = readLedger(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].executed_at, daysAgo(3));
    assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
    assert.throws(
      () => appendRow(file, row({ kind: "smoke" })),
      /refusing to append an invalid ledger row/,
    );
    assert.equal(readLedger(file).length, 2);
  });
  // A ledger whose last line lost its newline still appends cleanly.
  withTempLedger(JSON.stringify(row()), (file) => {
    appendRow(file, row({ executed_at: daysAgo(0) }));
    assert.equal(readLedger(file).length, 2);
  });
});

test("compareLedgers enforces append-only history", () => {
  const first = row({ executed_at: daysAgo(30) });
  const second = row({ executed_at: daysAgo(2) });
  assert.deepEqual(compareLedgers([first], [first, second]), {
    appendOnly: true,
    problems: [],
  });
  const edited = { ...first, verdict: "RED" };
  const modified = compareLedgers([first], [edited]);
  assert.equal(modified.appendOnly, false);
  assert.match(modified.problems[0], /row 1 changed/);
  const removed = compareLedgers([first, second], [first]);
  assert.equal(removed.appendOnly, false);
  assert.match(removed.problems[0], /lost 1 committed row/);
});

// `checkLedger` holds the frozen denominator: a condition that scored a PR at
// all must carry every defect that PR froze, so a committed row scores one
// whole fixture rather than a subset of it.
const firstFixture = contract.fixtures[0];
const wholeFixture = (bits = [1, 0]) =>
  Object.fromEntries(firstFixture.scorable_ids.map((id) => [String(id), bits]));

test("checkLedger validates rows, contract scope, and append-only history", () => {
  const good = row({
    conditions: { pipeline: condition({ per_defect: wholeFixture() }) },
  });
  const history = row({ contract_digest: DIGEST_B, executed_at: daysAgo(400) });
  withTempLedger(jsonl(history, good), (file) => {
    const checked = checkLedger({
      path: file,
      contract,
      contractDigest: DIGEST_A,
    });
    assert.deepEqual(checked.problems, []);
    assert.equal(checked.ok, true);
    assert.equal(checked.rows.length, 2);
    // A row scored against another contract is legal history, never compared.
    assert.deepEqual(checked.comparableRows, [good]);
  });

  const foreign = row({
    conditions: { pipeline: condition({ per_defect: { 1234: [1, 1] } }) },
  });
  withTempLedger(jsonl(foreign), (file) => {
    const checked = checkLedger({
      path: file,
      contract,
      contractDigest: DIGEST_A,
    });
    assert.equal(checked.ok, false);
    assert.match(
      checked.problems[0],
      /per_defect has 1234, which the contract does not score/,
    );
  });

  // The same unscored id under a retired contract digest is not a problem.
  withTempLedger(jsonl({ ...foreign, contract_digest: DIGEST_B }), (file) => {
    const checked = checkLedger({
      path: file,
      contract,
      contractDigest: DIGEST_A,
    });
    assert.deepEqual(checked.problems, []);
  });

  withTempLedger(jsonl(good), (file) => {
    const checked = checkLedger({
      path: file,
      contract,
      contractDigest: DIGEST_A,
      baseRows: [row({ verdict: "RED" })],
    });
    assert.equal(checked.ok, false);
    assert.match(checked.problems[0], /row 1 changed/);
  });

  withTempLedger("{oops\n", (file) => {
    const checked = checkLedger({ path: file, contract });
    assert.equal(checked.ok, false);
    assert.match(checked.problems[0], /line 1 is not valid JSON/);
  });
});

test("checkLedger refuses a row that drops a frozen defect from a scored PR", () => {
  const whole = wholeFixture();
  const dropped = firstFixture.scorable_ids.at(-1);
  const shrunk = { ...whole };
  delete shrunk[String(dropped)];
  // The remaining bits are all misses, so dropping one lifts recall from 4/10
  // to 4/8 and takes the defect out of the McNemar denominator with it. Every
  // other check in the pipeline reads the ids the row itself lists, so this is
  // the only place the frozen denominator is enforced.
  const laundered = row({
    conditions: { pipeline: condition({ per_defect: shrunk }) },
  });
  assert.deepEqual(validateLedgerRow(laundered), []);
  withTempLedger(jsonl(laundered), (file) => {
    const checked = checkLedger({
      path: file,
      contract,
      contractDigest: DIGEST_A,
    });
    assert.equal(checked.ok, false);
    assert.match(
      checked.problems[0],
      new RegExp(
        `scored PR ${firstFixture.pr} but omits ${dropped}; the contract freezes ${firstFixture.scorable_ids.length} defect`,
      ),
    );
  });

  // A PR the row never scored is not an omission: a canary runs the grid alone,
  // and a partial run scores only the PRs whose cells completed.
  const untouched = row({
    conditions: { pipeline: condition({ per_defect: whole }) },
  });
  withTempLedger(jsonl(untouched), (file) => {
    assert.deepEqual(
      checkLedger({ path: file, contract, contractDigest: DIGEST_A }).problems,
      [],
    );
  });
});

test("the committed ledger passes its own contract check", () => {
  const checked = checkLedger({
    path: path.join(repoRoot, "docs/evals/review-skill-ledger.jsonl"),
    contract,
  });
  assert.deepEqual(checked.problems, []);
});

test("freshness ages the ledger from executed_at alone", () => {
  const full = (days, overrides = {}) =>
    row({ executed_at: daysAgo(days), ...overrides });
  const cases = [
    {
      name: "a recent full run is green",
      rows: [full(10)],
      level: "green",
      reasons: [],
    },
    {
      name: "exactly freshness_warn days is still green",
      rows: [full(45)],
      level: "green",
      reasons: [],
    },
    {
      name: "one day past freshness_warn warns",
      rows: [full(46)],
      level: "warn",
      reasons: [/no run in 46 days \(freshness_warn 45\)/],
    },
    {
      name: "exactly freshness_red days only warns",
      rows: [full(60)],
      level: "warn",
      reasons: [/freshness_warn 45/],
    },
    {
      name: "one day past freshness_red is red",
      rows: [full(61)],
      level: "red",
      reasons: [/no run in 61 days \(freshness_red 60\)/],
    },
    {
      name: "a harness that runs but never succeeds goes red at complete_red",
      rows: [full(91), full(2, { kind: "canary", status: "failed" })],
      level: "red",
      reasons: [/no complete run in 91 days \(complete_red 90\)/],
    },
    {
      name: "complete canaries do not hold off the full-run clock",
      rows: [full(121), full(3, { kind: "canary" })],
      level: "red",
      reasons: [/no full run in 121 days \(full_red 120\)/],
    },
    {
      name: "a failed full run does not restart the full-run clock",
      // The trace row a failed run leaves keeps `kind: "full"`. It records that
      // the harness tried, not that the operating point is still verified, so
      // the quarterly clock keeps running and `resolveKind` keeps asking for a
      // full run instead of dropping back to canaries for another window.
      rows: [full(121), full(1, { status: "failed", verdict: "INCOMPLETE" })],
      level: "red",
      reasons: [/no full run in 121 days \(full_red 120\)/],
    },
    {
      name: "a partial full run does not restart the full-run clock either",
      rows: [full(121), full(1, { status: "partial", verdict: "AMBER" })],
      level: "red",
      reasons: [/no full run in 121 days \(full_red 120\)/],
    },
    {
      name: "an empty ledger counts from established_at and warns",
      rows: [],
      now: new Date("2026-10-11T00:00:00Z"),
      level: "warn",
      reasons: [/counting from established_at 2026-08-25/, /freshness_warn 45/],
    },
    {
      name: "an empty ledger eventually goes red",
      rows: [],
      now: new Date("2026-10-26T00:00:00Z"),
      level: "red",
      reasons: [/counting from established_at/, /freshness_red 60/],
    },
    {
      name: "a brand-new suite is green inside the grace window",
      rows: [],
      now: new Date("2026-09-05T00:00:00Z"),
      level: "green",
      reasons: [/counting from established_at/],
    },
    {
      name: "rows from another contract never count",
      rows: [full(2, { contract_digest: DIGEST_B })],
      now: new Date("2026-12-01T00:00:00Z"),
      level: "red",
      reasons: [/counting from established_at/, /freshness_red 60/],
    },
  ];
  for (const item of cases) {
    const result = freshness({
      rows: item.rows,
      contract,
      now: item.now ?? NOW,
      contractDigest: DIGEST_A,
    });
    assert.equal(result.level, item.level, item.name);
    for (const pattern of item.reasons) {
      assert.ok(
        result.reasons.some((reason) => pattern.test(reason)),
        `${item.name}: expected ${pattern} in ${JSON.stringify(result.reasons)}`,
      );
    }
    if (item.reasons.length === 0)
      assert.deepEqual(result.reasons, [], item.name);
  }
});

test("freshness reports the clocks and the rows it excluded", () => {
  const result = freshness({
    rows: [
      row({ executed_at: daysAgo(5), kind: "canary", status: "partial" }),
      row({ executed_at: daysAgo(50) }),
      row({ executed_at: daysAgo(1), contract_digest: DIGEST_B }),
    ],
    contract,
    now: NOW,
    contractDigest: DIGEST_A,
  });
  assert.equal(result.daysSinceAny, 5);
  assert.equal(result.daysSinceComplete, 50);
  assert.equal(result.daysSinceFull, 50);
  assert.equal(result.excludedRows, 1);
  assert.equal(result.lastFullAt, daysAgo(50));
  assert.equal(result.evaluatedAt, NOW.toISOString());
  assert.equal(result.level, "green");
});

test("freshness refuses an unusable contract or clock", () => {
  assert.throws(
    () => freshness({ rows: [], contract: { ...contract, cadence_days: {} } }),
    /cadence_days.freshness_warn/,
  );
  assert.throws(
    () =>
      freshness({ rows: [], contract: { ...contract, established_at: "" } }),
    /established_at/,
  );
  assert.throws(
    () => freshness({ rows: [], contract, now: new Date("nope") }),
    /usable `now`/,
  );
});
