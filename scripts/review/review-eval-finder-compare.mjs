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
import {
  judgeCalibrationPasses,
  leakSuspected,
} from "./review-eval-report.mjs";
import { aggregateDraws, scorerDigest } from "./review-eval-score.mjs";

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
  // The canonical baseline path refuses a leaked row for the same reason
  // (`baselineEligibility` in `review-eval-report.mjs`): the answer key may
  // have reached the contestant, so a matched id no longer measures the
  // finder. `scorePlan` keeps such a cell's ids so the leak stays visible in
  // the detail; nothing may rank on them.
  if (leakSuspected(row)) {
    throw new Error(
      `${dir} records a suspected leak in its row notes; its matched ids are not trusted evidence`,
    );
  }
  return row;
}

/** A per-cell count `foldCondition` reads. Absent, it would read as zero. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * `matched_ids` as the run wrote it: an array of ids, never a shape. The
 * contract's ids are numbers and `aggregateDraws` matches by strict set
 * membership, so a numeric string is read as its number, the way the canonical
 * evidence validator compares string forms; anything else is refused.
 */
function requireIdArray(value, file) {
  if (!Array.isArray(value)) {
    throw new Error(
      `${file} matched_ids must be an array of ids; the result cannot be compared`,
    );
  }
  return value.map((id) => {
    const number = typeof id === "string" && id !== "" ? Number(id) : id;
    if (!Number.isSafeInteger(number)) {
      throw new Error(
        `${file} matched_ids carries ${JSON.stringify(id)}, which is not an integer id; the result cannot be compared`,
      );
    }
    return number;
  });
}

function requireCount(value, label, file) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${file} carries ${label} ${JSON.stringify(value)}; a nonnegative integer is required`,
    );
  }
  return value;
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
  const leaked = [];
  const completed = readCompletedCells(dir);
  for (const cell of plan.cells ?? []) {
    if (cell.condition !== "pipeline" || cell.draw !== 1) continue;
    // An identical retry reuses the directory, and a cell that succeeded once
    // and failed on retry leaves its old root result behind. The run's own
    // manifest says which results belong to the current run; a file outside
    // it is stale evidence and reads as a missing cell.
    if (!completed.has(cell.cell_id)) continue;
    const file = path.join(dir, `result-${cell.pr}-pipeline-1.json`);
    if (!existsSync(file)) continue;
    const result = readJson(file);
    const fixture = (contract.fixtures ?? []).find(
      (candidate) => candidate.pr === cell.pr,
    );
    if (!fixture) continue;
    // A leaked cell keeps its matched ids so the leak stays visible in the
    // detail, and reading them here would score contaminated bits as recall.
    if (result.leak?.suspected === true) leaked.push(cell.pr);
    const aggregate = aggregateDraws({
      scorableIds: fixture.scorable_ids,
      p1Ids: fixture.p1_ids ?? [],
      draws: [
        {
          matchedIds: requireIdArray(result.matched_ids, file),
          scorableIds: fixture.scorable_ids,
        },
      ],
    });
    byPr.set(cell.pr, {
      pr: cell.pr,
      matched: aggregate.recall.matched,
      p1_matched: aggregate.p1.matched,
      p1_opportunities: aggregate.p1.opportunities,
      wrong_claims: requireCount(
        result.novel?.novelWrong,
        "novel.novelWrong",
        file,
      ),
    });
  }
  if (leaked.length > 0) {
    throw new Error(
      `${dir} records a suspected leak on PR ${leaked.join(", ")}; its matched ids are not trusted evidence`,
    );
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
      claude_cli: plan.inputs?.claude_cli ?? null,
      codex_cli: plan.inputs?.codex_cli ?? null,
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

/** The current run's completed cells, from the manifest `scorePlan` writes. */
function readCompletedCells(dir) {
  const file = path.join(dir, "calibration.json");
  if (!existsSync(file)) {
    throw new Error(
      `${dir} carries no calibration.json; the run's completed-cell manifest cannot be read`,
    );
  }
  const ids = readJson(file)?.completed_cell_ids;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error(
      `${dir}/calibration.json completed_cell_ids must be an array of non-empty strings`,
    );
  }
  return new Set(ids);
}

/** Pair the two arms by PR and total the differences. */
export function compareArms({
  anchor,
  candidate,
  contractDigest = null,
  matcherDigest = null,
  allowScorerDrift = false,
}) {
  assertComparable(anchor.identity, candidate.identity, {
    contractDigest,
    allowScorerDrift,
  });
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
      matcherDigest,
    ),
    notes: identityNotes(anchor.identity, candidate.identity),
  };
}

const short = (value) => String(value).slice(0, 8);

/**
 * The scoring inputs that decide what a matched id counts as: the contract
 * freezes the ids and the recall denominator, the scorer decides what matches
 * one, and the calibration set is what qualified the judge. A difference in any
 * of them makes the two matched counts answers to different questions, so it is
 * refused rather than warned about — a net computed across it means nothing.
 *
 * `comparability_key` and `orchestrator_digest` are deliberately not here. The
 * key binds the orchestrator digest, and a probe of a new finder is normally
 * planned on an edited harness, so its key always differs from the anchor's.
 * Refusing on the key would make every probe incomparable with every anchor —
 * which is the whole point of the lane. The scoring inputs above are what must
 * match; the key and the harness bytes are named and left to the reader.
 */
const SCORING_IDENTITY = [
  ["contract_digest", "contracts"],
  ["matcher_digest", "scorers"],
  ["calibration_digest", "judge calibration sets"],
];

/**
 * Refuse a comparison whose two arms were not scored the same way.
 *
 * The loaded contract is checked against both arms as well, because this
 * process recomputes every count from its `scorable_ids` and `p1_ids`: an arm
 * planned on other fixture bits is being rescored against a denominator it
 * never ran under, and that is a contract difference wearing a finder's name.
 *
 * The loaded scorer is deliberately not checked that way. It did not produce
 * either arm's `matched_ids` — those are committed evidence, and the only thing
 * recomputed here is recall arithmetic, applied identically to both sides. The
 * scorer digest moves whenever any scoring module is edited, which is the
 * normal state of the branch a probe is planned on, so refusing on it would
 * refuse every probe against every earlier anchor. It is warned about instead.
 */
export function assertComparable(
  anchor,
  candidate,
  { contractDigest = null, allowScorerDrift = false } = {},
) {
  for (const [field, label] of SCORING_IDENTITY) {
    for (const [side, arm] of [
      ["anchor", anchor],
      ["candidate", candidate],
    ]) {
      if (!DIGEST.test(String(arm[field] ?? ""))) {
        throw new Error(
          `the ${side} plan records no ${label.replace(/s$/, "")} digest; a run without scoring provenance cannot be compared`,
        );
      }
    }
    if (anchor[field] === candidate[field]) continue;
    // `--allow-scorer-drift`: the operator has read which scoring modules
    // changed between the two plans and vouches that matching did not. The
    // difference is still printed as a warning; it never disappears.
    if (field === "matcher_digest" && allowScorerDrift) continue;
    throw new Error(
      `the two runs were planned against different ${label} (${short(anchor[field])} vs ${short(candidate[field])}); a matched-id difference between them would not be a finder difference`,
    );
  }
  if (!contractDigest) return;
  for (const [side, arm] of [
    ["anchor", anchor],
    ["candidate", candidate],
  ]) {
    if (arm.contract_digest !== contractDigest) {
      throw new Error(
        `the ${side} was planned against contract ${short(arm.contract_digest)}, but these counts are recomputed from ${short(contractDigest)}`,
      );
    }
  }
}

/** Differences that leave the comparison readable but shape how it reads. */
export function identityWarnings(anchor, candidate, matcherDigest = null) {
  const warnings = [];
  // Only reachable under --allow-scorer-drift; without it this is a refusal.
  if (anchor.matcher_digest !== candidate.matcher_digest) {
    warnings.push(
      `the two runs were planned against different scorers (${short(anchor.matcher_digest)} vs ${short(candidate.matcher_digest)}); accepted by --allow-scorer-drift, so read a matched-id difference as finder-or-scorer until the scoring diff is checked`,
    );
  }
  // Both arms agree with each other or `assertComparable` already refused, so
  // this names a scorer edit between the runs and this checkout — the ordinary
  // case on the branch a probe is planned on. See `assertComparable`.
  if (
    matcherDigest &&
    anchor.matcher_digest &&
    anchor.matcher_digest !== matcherDigest
  ) {
    warnings.push(
      `both runs were scored under ${short(anchor.matcher_digest)}, but this checkout's scorer is ${short(matcherDigest)}; the recomputed counts are recall arithmetic over committed matched ids, not a rescore`,
    );
  }
  // Named, never refused: see SCORING_IDENTITY for why the key cannot gate a
  // probe. A different key still means the two rows are not ledger-comparable.
  if (anchor.comparability_key !== candidate.comparability_key) {
    warnings.push(
      `the two runs carry different comparability keys (${short(anchor.comparability_key)} vs ${short(candidate.comparability_key)}); their rows are not comparable in the ledger, only here`,
    );
  }
  if (anchor.skill_digest !== candidate.skill_digest) {
    warnings.push(
      "the two runs used different review skills; a matched-id difference is not a finder difference",
    );
  }
  // The CLI versions are deliberately outside the comparability key (ADR
  // 0085), so a straddled upgrade is named here: a codex change can move the
  // finder's output, a claude change the verifier's and the judge's.
  for (const [field, label] of [
    ["codex_cli", "codex CLI (the finder's runtime)"],
    ["claude_cli", "claude CLI (the verifier's and judge's runtime)"],
  ]) {
    if (anchor[field] !== candidate[field]) {
      warnings.push(
        `the two runs straddle a ${label} change (${anchor[field]} vs ${candidate[field]}); a matched-id difference may be runtime drift, not a finder difference`,
      );
    }
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
  for (const side of ["anchor", "candidate"]) {
    const arm = report[side];
    lines.push(
      `${side.padEnd(9)} finder ${arm.finder} argv ${short(arm.finder_argv_digest)} skill ${short(arm.skill_digest)} orchestrator ${short(arm.orchestrator_digest)} judge ${arm.judge?.model}@${arm.judge?.effort} calibration ${arm.judge_calibration?.agreement}/${arm.judge_calibration?.total} cli ${arm.codex_cli} / ${arm.claude_cli}`,
    );
    lines.push(
      `${" ".repeat(9)} contract ${short(arm.contract_digest)} scorer ${short(arm.matcher_digest)} calibration set ${short(arm.calibration_digest)} key ${short(arm.comparability_key)}`,
    );
  }
  lines.push(
    `loaded    contract ${short(report.contract_digest)} scorer ${short(report.matcher_digest)}`,
  );
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

export function buildReport({
  anchorDir,
  candidateDir,
  repoRoot,
  allowScorerDrift = false,
}) {
  const { contract, digest: contractDigest } = loadContract(
    path.resolve(repoRoot, DEFAULT_CONTRACT_PATH),
  );
  const anchor = readArm({ dir: path.resolve(anchorDir), contract });
  const candidate = readArm({ dir: path.resolve(candidateDir), contract });
  const matcherDigest = scorerDigest();
  const compared = compareArms({
    anchor,
    candidate,
    contractDigest,
    matcherDigest,
    allowScorerDrift,
  });
  return {
    contract_digest: contractDigest,
    matcher_digest: matcherDigest,
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
      "allow-scorer-drift": { type: "boolean" },
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
  --allow-scorer-drift
                   Compare across a scorer-digest change between the two plans
                   (printed as a warning instead of refused); use only after
                   reading the scoring diff between the two harness revisions
`,
    );
    return values.help ? 0 : 1;
  }
  const report = buildReport({
    anchorDir: values.anchor,
    candidateDir: values.candidate,
    repoRoot: values.root ?? env.PWD ?? process.cwd(),
    allowScorerDrift: values["allow-scorer-drift"] === true,
  });
  process.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
