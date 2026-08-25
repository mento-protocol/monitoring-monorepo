#!/usr/bin/env node

// Ledger-row shape helpers: build the row a failed run leaves behind, pick the
// row a candidate may be paired against, and recompute a committed row from its
// own evidence.
//
// Nothing here calls a model. `revalidateRow` is what makes a committed row
// evidence rather than a claim: a self-reported score is never trusted.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { fixtureForPr } from "./review-eval-fixtures.mjs";
import { verdict } from "./review-eval-report.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

/** True for a plain object, the only shape the recompute below can read. */
function isShape(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Defect ids one condition can score, given the PRs its cells cover. */
export function conditionScope({ contract, cells, condition }) {
  const prs = [
    ...new Set(
      cells.filter((cell) => cell.condition === condition).map((c) => c.pr),
    ),
  ];
  const scorableIds = [];
  const p1Ids = [];
  for (const pr of prs) {
    const fixture = fixtureForPr(contract, pr);
    scorableIds.push(...fixture.scorable_ids);
    p1Ids.push(...fixture.p1_ids);
  }
  return { prs, scorableIds, p1Ids };
}

/**
 * The row an unrecoverable run leaves behind. A failed run must still leave a
 * trace: a run that leaves nothing is indistinguishable from a run that never
 * happened, and the freshness guard cannot tell those apart either.
 *
 * The schema requires at least one condition, so the headline condition is
 * recorded with every bit zero. `status: "failed"` keeps it out of every
 * ranking and out of baseline selection.
 */
export function failedRow({
  plan,
  contract,
  contractDigest,
  reason,
  now = new Date(),
}) {
  const name = plan.cells[0]?.condition ?? "pipeline";
  const scope = conditionScope({
    contract,
    cells: plan.cells,
    condition: name,
  });
  const perDefect = Object.fromEntries(
    scope.scorableIds.map((id) => [String(id), [0]]),
  );
  const zero = (ids) => ({
    matched: 0,
    opportunities: ids.length,
    rate: ids.length === 0 ? null : 0,
  });
  return {
    schema_version: 1,
    kind: plan.kind,
    executed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "failed",
    verdict: "INCOMPLETE",
    comparability_key: plan.comparability_key,
    contract_digest: contractDigest,
    inputs: plan.inputs,
    conditions: {
      [name]: {
        model: plan.cells[0]?.model ?? contract.sut.verifier.model,
        effort: plan.cells[0]?.effort ?? contract.sut.verifier.effort,
        draws: 1,
        recall: zero(scope.scorableIds),
        p1: zero(scope.p1Ids),
        novel_real: 0,
        wrong_claims: 0,
        usd: 0,
        seconds: 0,
        per_defect: perDefect,
      },
    },
    judge_calibration: { agreement: 0, total: 1 },
    vs_baseline: null,
    detail_dir: plan.detail_dir,
    notes: `run failed: ${String(reason).slice(0, 400)}`,
  };
}

/** The newest earlier full, complete row this row may be paired against. */
export function resolveBaseline({ rows, row }) {
  const eligible = (rows ?? []).filter(
    (candidate) =>
      candidate.kind === "full" &&
      candidate.status === "complete" &&
      candidate.comparability_key === row.comparability_key &&
      candidate.executed_at < row.executed_at,
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((newest, candidate) =>
    candidate.executed_at > newest.executed_at ? candidate : newest,
  );
}

/** Read one row from a file path, or from the ledger by executed_at prefix. */
export function resolveRowReference({ reference, rows, repoRoot }) {
  if (!reference) return null;
  const asPath = path.resolve(repoRoot, reference);
  if (existsSync(asPath) && statSync(asPath).isFile()) return readJson(asPath);
  const matches = (rows ?? []).filter((row) =>
    String(row.executed_at).startsWith(reference),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`no ledger row and no file matches ${reference}`);
  }
  throw new Error(`${reference} matches ${matches.length} ledger rows`);
}

function recomputeFromDetail({ dir, condition, ids, prForId }) {
  let files;
  try {
    files = readdirSync(dir).filter(
      (name) =>
        name.startsWith("result-") &&
        name.includes(`-${condition}-`) &&
        name.endsWith(".json"),
    );
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const byDraw = new Map();
  for (const file of files) {
    const record = readJson(path.join(dir, file));
    const draw = Number(record.draw);
    const entry = byDraw.get(draw) ?? { matched: new Set(), prs: new Set() };
    for (const id of record.matched_ids ?? []) entry.matched.add(String(id));
    entry.prs.add(String(record.pr));
    byDraw.set(draw, entry);
  }
  const draws = [...byDraw.keys()].sort((a, b) => a - b);
  const bits = new Map();
  // A draw scores only the PRs that completed it, exactly as `foldCondition`
  // folds them, so a PR that never ran a draw contributes no bit for it.
  for (const id of ids) {
    const pr = prForId?.get(String(id));
    bits.set(
      id,
      draws
        .filter(
          (draw) => pr === undefined || byDraw.get(draw).prs.has(String(pr)),
        )
        .map((draw) => (byDraw.get(draw).matched.has(id) ? 1 : 0)),
    );
  }
  return bits;
}

/**
 * Recompute a row's numbers from its own per-defect bits and, when the run
 * detail is on disk, from the per-cell matched ids. A self-reported score is
 * never trusted; this is what makes a committed row evidence.
 *
 * The verdict is recomputed the same way, against the baseline the ledger
 * rows resolve to, because the verdict is the one field a human reads first.
 */
export function revalidateRow({
  contract,
  row,
  repoRoot,
  detailDir = null,
  ledgerRows = [],
  baselineRow = null,
}) {
  const problems = [];
  const dir =
    detailDir ?? (row.detail_dir ? path.join(repoRoot, row.detail_dir) : null);
  const p1 = new Set(
    contract.fixtures.flatMap((fixture) => fixture.p1_ids.map(String)),
  );
  const prForId = new Map(
    contract.fixtures.flatMap((fixture) =>
      fixture.scorable_ids.map((id) => [String(id), fixture.pr]),
    ),
  );
  for (const [name, condition] of Object.entries(row.conditions ?? {})) {
    const label = `conditions.${name}`;
    // `--validate` reads a row file it did not write, so every field here is
    // untrusted. A missing one is a problem to report, not a stack trace that
    // replaces the problem list the command promises.
    if (!isShape(condition)) {
      problems.push(`${label} is not an object; nothing to recompute`);
      continue;
    }
    const ids = Object.keys(condition.per_defect ?? {});
    if (ids.length === 0) {
      problems.push(`${label}.per_defect is empty`);
      continue;
    }
    if (!isShape(condition.recall) || !isShape(condition.p1)) {
      problems.push(`${label} is missing recall or p1; nothing to recompute`);
      continue;
    }
    const bits = ids.flatMap((id) => condition.per_defect[id]);
    const matched = bits.filter((bit) => bit === 1).length;
    if (matched !== condition.recall.matched) {
      problems.push(
        `${label}.recall.matched is ${condition.recall.matched}; the bits give ${matched}`,
      );
    }
    if (bits.length !== condition.recall.opportunities) {
      problems.push(
        `${label}.recall.opportunities is ${condition.recall.opportunities}; the bits give ${bits.length}`,
      );
    }
    const p1Matched = ids
      .filter((id) => p1.has(id))
      .flatMap((id) => condition.per_defect[id])
      .filter((bit) => bit === 1).length;
    if (p1Matched !== condition.p1.matched) {
      problems.push(
        `${label}.p1.matched is ${condition.p1.matched}; the bits give ${p1Matched}`,
      );
    }
    if (!dir || !existsSync(dir)) continue;
    const recomputed = recomputeFromDetail({
      dir,
      condition: name,
      ids,
      prForId,
    });
    if (!recomputed) continue;
    for (const id of ids) {
      const stated = condition.per_defect[id].join("");
      const found = (recomputed.get(id) ?? []).join("");
      if (found !== stated) {
        problems.push(
          `${label}.per_defect.${id} is ${stated}; the run detail gives ${found || "no draw"}`,
        );
      }
    }
  }
  const baseline =
    baselineRow ?? resolveBaseline({ rows: ledgerRows ?? [], row });
  let recomputed = null;
  try {
    recomputed = verdict({ contract, row, baselineRow: baseline }).verdict;
  } catch (error) {
    problems.push(
      `the verdict could not be recomputed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (recomputed && recomputed !== row.verdict) {
    problems.push(
      `row.verdict is ${row.verdict}; the row's own numbers give ${recomputed}`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    detail_dir: dir,
    verdict: recomputed,
    baseline_executed_at: baseline?.executed_at ?? null,
  };
}
