#!/usr/bin/env node

// Compare two review-skill eval detail directories by fixture, on the pipeline
// draw-1 cells alone. It reads committed evidence only: no model, no network,
// no mutation. The candidate is normally a `--kind finder` probe and the anchor
// a canonical full run, but any two detail directories with pipeline draw-1
// cells pair here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONTRACT_PATH,
  loadContract,
} from "./review-eval-fixtures.mjs";
import { judgeCalibrationPasses } from "./review-eval-report.mjs";
import { aggregateDraws } from "./review-eval-score.mjs";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The run's own row, refused when its judge failed calibration. Every matched
 * id on both sides of this comparison was read by that judge, so a run whose
 * agreement fell below the floor cannot support a finder claim in either
 * direction — and printing its nets beside a passing run's invites exactly
 * that. The rule lives in `review-eval-report.mjs`; do not restate it here.
 */
function readCheckedRow(dir) {
  const file = path.join(dir, "row.json");
  if (!existsSync(file)) {
    throw new Error(
      `${dir} carries no row.json; the run's judge calibration cannot be checked`,
    );
  }
  const row = readJson(file);
  if (!judgeCalibrationPasses(row)) {
    const calibration = row?.judge_calibration;
    const recorded = calibration
      ? `${calibration.agreement}/${calibration.total}`
      : "nothing";
    throw new Error(
      `${dir} recorded judge calibration ${recorded}, which does not pass; its matched ids are not usable evidence`,
    );
  }
  return row;
}

/**
 * The pipeline draw-1 evidence of one detail directory, by PR. `matched_ids`
 * and the per-cell `novel` counts are the same fields `foldCondition` reads, so
 * the numbers here are the ledger's numbers restricted to one draw.
 */
export function readArm({ dir, contract }) {
  const plan = readJson(path.join(dir, "plan.json"));
  const row = readCheckedRow(dir);
  const byPr = new Map();
  for (const cell of plan.cells ?? []) {
    if (cell.condition !== "pipeline" || cell.draw !== 1) continue;
    const file = path.join(dir, `result-${cell.pr}-pipeline-1.json`);
    if (!existsSync(file)) continue;
    const result = readJson(file);
    const fixture = (contract.fixtures ?? []).find(
      (candidate) => candidate.pr === cell.pr,
    );
    if (!fixture) continue;
    const aggregate = aggregateDraws({
      scorableIds: fixture.scorable_ids,
      p1Ids: fixture.p1_ids ?? [],
      draws: [
        {
          matchedIds: result.matched_ids ?? [],
          scorableIds: fixture.scorable_ids,
        },
      ],
    });
    byPr.set(cell.pr, {
      pr: cell.pr,
      matched: aggregate.recall.matched,
      p1_matched: aggregate.p1.matched,
      p1_opportunities: aggregate.p1.opportunities,
      wrong_claims: result.novel?.novelWrong ?? 0,
    });
  }
  return {
    dir,
    plan,
    row,
    byPr,
    identity: {
      finder: plan.cells?.find((cell) => cell.finder)?.finder ?? null,
      finder_argv_digest: plan.inputs?.finder_argv_digest ?? null,
      skill_digest: plan.inputs?.skill_digest ?? null,
      orchestrator_digest: plan.inputs?.orchestrator_digest ?? null,
      comparability_key: plan.comparability_key ?? null,
      contract_digest: plan.contract_digest ?? null,
      matcher_digest: plan.matcher_digest ?? null,
      calibration_digest: plan.calibration_digest ?? null,
      judge: plan.judge ?? null,
      judge_calibration: row?.judge_calibration ?? null,
    },
  };
}

/**
 * Exact paired sign-flip test on the per-PR differences, both tails. Under the
 * null the two arms are exchangeable inside a pair, so every non-zero
 * difference could have carried either sign; the p-value is the share of the
 * 2**k assignments whose sum reaches the observed net. Nine fixtures give at
 * most 512 assignments, so no sampling is needed.
 */
export function signFlip(differences) {
  const informative = differences.filter((value) => value !== 0);
  const net = informative.reduce((sum, value) => sum + value, 0);
  const assignments = 2 ** informative.length;
  let greater = 0;
  let less = 0;
  for (let mask = 0; mask < assignments; mask += 1) {
    let sum = 0;
    for (let index = 0; index < informative.length; index += 1) {
      sum += (mask >> index) & 1 ? -informative[index] : informative[index];
    }
    if (sum >= net) greater += 1;
    if (sum <= net) less += 1;
  }
  return {
    method: "exact",
    n: differences.length,
    informative_pairs: informative.length,
    net,
    p_greater: greater / assignments,
    p_less: less / assignments,
  };
}

/** Pair the two arms by PR and total the differences. */
export function compareArms({ anchor, candidate, contractDigest = null }) {
  const paired = [...anchor.byPr.keys()]
    .filter((pr) => candidate.byPr.has(pr))
    .sort((left, right) => left - right);
  const rows = paired.map((pr) => {
    const a = anchor.byPr.get(pr);
    const c = candidate.byPr.get(pr);
    return { pr, anchor: a, candidate: c, net: c.matched - a.matched };
  });
  const sum = (side, field) =>
    rows.reduce((total, row) => total + row[side][field], 0);
  const totals = {
    prs: rows.length,
    net: rows.reduce((total, row) => total + row.net, 0),
    anchor: {
      matched: sum("anchor", "matched"),
      p1_matched: sum("anchor", "p1_matched"),
      p1_opportunities: sum("anchor", "p1_opportunities"),
      wrong_claims: sum("anchor", "wrong_claims"),
    },
    candidate: {
      matched: sum("candidate", "matched"),
      p1_matched: sum("candidate", "p1_matched"),
      p1_opportunities: sum("candidate", "p1_opportunities"),
      wrong_claims: sum("candidate", "wrong_claims"),
    },
  };
  const skipped = {
    anchor_only: [...anchor.byPr.keys()]
      .filter((pr) => !candidate.byPr.has(pr))
      .sort((left, right) => left - right),
    candidate_only: [...candidate.byPr.keys()]
      .filter((pr) => !anchor.byPr.has(pr))
      .sort((left, right) => left - right),
  };
  return {
    rows,
    totals,
    skipped,
    sign_flip: signFlip(rows.map((row) => row.net)),
    warnings: identityWarnings(
      anchor.identity,
      candidate.identity,
      contractDigest,
    ),
    notes: identityNotes(anchor.identity, candidate.identity),
  };
}

/**
 * Plan fields that must agree for a matched-id difference to be about the
 * finder. Each one decides what a matched id counts as: the contract freezes
 * the ids, the scorer decides what matches one, the calibration set is what
 * qualified the judge, and the comparability key binds all of it plus the
 * orchestrator into the identity a ledger row is ranked under.
 */
const PAIRED_IDENTITY = [
  ["contract_digest", "contracts"],
  ["matcher_digest", "scorers"],
  ["calibration_digest", "judge calibration sets"],
  ["comparability_key", "comparability keys"],
];

/**
 * Differences that invalidate the comparison rather than being its subject.
 *
 * `contractDigest` is the contract this process loaded. Every count here is
 * recomputed from that contract's `scorable_ids` and `p1_ids`, so a run planned
 * against different fixture bits is being read through a scoring key it never
 * ran under, and the difference is a contract difference, not a finder one.
 */
export function identityWarnings(anchor, candidate, contractDigest = null) {
  const warnings = [];
  const short = (value) => String(value).slice(0, 8);
  for (const [field, label] of PAIRED_IDENTITY) {
    if (anchor[field] === candidate[field]) continue;
    warnings.push(
      `the two runs were planned against different ${label} (${short(anchor[field])} vs ${short(candidate[field])}); a matched-id difference is not a finder difference`,
    );
  }
  if (contractDigest) {
    for (const [side, arm] of [
      ["anchor", anchor],
      ["candidate", candidate],
    ]) {
      if (arm.contract_digest && arm.contract_digest !== contractDigest) {
        warnings.push(
          `the ${side} was planned against contract ${short(arm.contract_digest)}, but these counts are recomputed from ${short(contractDigest)}`,
        );
      }
    }
  }
  if (anchor.skill_digest !== candidate.skill_digest) {
    warnings.push(
      "the two runs used different review skills; a matched-id difference is not a finder difference",
    );
  }
  if (
    anchor.judge?.model !== candidate.judge?.model ||
    anchor.judge?.effort !== candidate.judge?.effort
  ) {
    warnings.push(
      `the judge differs (${anchor.judge?.model}@${anchor.judge?.effort} vs ${candidate.judge?.model}@${candidate.judge?.effort}); the two matched counts were not read by the same judge`,
    );
  }
  return warnings;
}

/** Differences worth naming that leave the comparison usable. */
export function identityNotes(anchor, candidate) {
  const notes = [];
  if (anchor.orchestrator_digest !== candidate.orchestrator_digest) {
    notes.push(
      "the orchestrator sources differ; the comparison stands, but the two runs were executed by different harness bytes",
    );
  }
  return notes;
}

function rate(matched, opportunities) {
  return opportunities === 0 ? "n/a" : (matched / opportunities).toFixed(3);
}

function render(report) {
  const lines = [];
  const short = (value) => String(value).slice(0, 8);
  for (const side of ["anchor", "candidate"]) {
    const arm = report[side];
    lines.push(
      `${side.padEnd(9)} finder ${arm.finder} argv ${short(arm.finder_argv_digest)} skill ${short(arm.skill_digest)} orchestrator ${short(arm.orchestrator_digest)} judge ${arm.judge?.model}@${arm.judge?.effort} calibration ${arm.judge_calibration?.agreement}/${arm.judge_calibration?.total}`,
    );
    lines.push(
      `${" ".repeat(9)} contract ${short(arm.contract_digest)} scorer ${short(arm.matcher_digest)} calibration set ${short(arm.calibration_digest)} key ${short(arm.comparability_key)}`,
    );
  }
  lines.push(`loaded    contract ${short(report.contract_digest)}`);
  lines.push("");
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  if (report.warnings.length || report.notes.length) lines.push("");
  lines.push(
    ["pr", "matched", "cand", "net", "p1", "cand p1", "wrong", "cand wrong"]
      .map((head, index) => head.padStart(index === 0 ? 6 : 11))
      .join(""),
  );
  for (const row of report.rows) {
    lines.push(
      [
        String(row.pr).padStart(6),
        String(row.anchor.matched).padStart(11),
        String(row.candidate.matched).padStart(11),
        String(row.net > 0 ? `+${row.net}` : row.net).padStart(11),
        `${row.anchor.p1_matched}/${row.anchor.p1_opportunities}`.padStart(11),
        `${row.candidate.p1_matched}/${row.candidate.p1_opportunities}`.padStart(
          11,
        ),
        String(row.anchor.wrong_claims).padStart(11),
        String(row.candidate.wrong_claims).padStart(11),
      ].join(""),
    );
  }
  const { totals } = report;
  lines.push("");
  lines.push(
    `paired PRs ${totals.prs}; net matched ${totals.net > 0 ? `+${totals.net}` : totals.net} (anchor ${totals.anchor.matched}, candidate ${totals.candidate.matched})`,
  );
  lines.push(
    `P1 recall  anchor ${totals.anchor.p1_matched}/${totals.anchor.p1_opportunities} (${rate(totals.anchor.p1_matched, totals.anchor.p1_opportunities)}), candidate ${totals.candidate.p1_matched}/${totals.candidate.p1_opportunities} (${rate(totals.candidate.p1_matched, totals.candidate.p1_opportunities)})`,
  );
  lines.push(
    `wrong claims anchor ${totals.anchor.wrong_claims}, candidate ${totals.candidate.wrong_claims}`,
  );
  const test = report.sign_flip;
  lines.push(
    `sign-flip ${test.method}: n ${test.n}, informative ${test.informative_pairs}, net ${test.net}, p_greater ${test.p_greater.toFixed(4)}, p_less ${test.p_less.toFixed(4)}`,
  );
  for (const [side, prs] of Object.entries(report.skipped)) {
    if (prs.length) lines.push(`skipped (${side}): ${prs.join(", ")}`);
  }
  lines.push(
    "one draw per fixture: enough to reject a finder, never to promote one",
  );
  return `${lines.join("\n")}\n`;
}

export function buildReport({ anchorDir, candidateDir, repoRoot }) {
  const { contract, digest: contractDigest } = loadContract(
    path.resolve(repoRoot, DEFAULT_CONTRACT_PATH),
  );
  const anchor = readArm({ dir: path.resolve(anchorDir), contract });
  const candidate = readArm({ dir: path.resolve(candidateDir), contract });
  const compared = compareArms({ anchor, candidate, contractDigest });
  return {
    contract_digest: contractDigest,
    anchor: { dir: anchor.dir, ...anchor.identity },
    candidate: { dir: candidate.dir, ...candidate.identity },
    ...compared,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      anchor: { type: "string" },
      candidate: { type: "string" },
      root: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help || !values.anchor || !values.candidate) {
    process.stdout.write(
      `Usage: node scripts/review/review-eval-finder-compare.mjs --anchor DIR --candidate DIR [--json]

Compare two eval detail directories on their pipeline draw-1 cells, by PR.
Reads committed evidence only: no model call, no network, no mutation.

  --anchor DIR     Detail directory of the run being compared against
  --candidate DIR  Detail directory of the run under test
  --root PATH      Repository root the contract is read from (default: cwd)
  --json           Print one machine-readable object
`,
    );
    return values.help ? 0 : 1;
  }
  const report = buildReport({
    anchorDir: values.anchor,
    candidateDir: values.candidate,
    repoRoot: values.root ?? env.PWD ?? process.cwd(),
  });
  process.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
