// The finder substitution behind `--kind finder --finder MODEL@EFFORT`.
//
// It rewrites the contract's finder for one plan and nothing else. The contract
// on disk never moves, and the substitution reaches the spawned command through
// the plan: `run-eval-runtime.sh` reads `FINDER_ARGV` from the plan's own
// pipeline cell. `finder_argv_digest` therefore records the overridden vector,
// which is what stops a probe cell from reusing a canonical run's cell.
//
// What it must not move is the comparability key. The key names the contract a
// probe is read against; keyed on the substitution instead, a probe would start
// its own lineage and be comparable with nothing.

import { createHash } from "node:crypto";

export const FINDER_EFFORTS = ["low", "medium", "high", "xhigh"];

// The rule every finder argv element must satisfy: `run-eval-runtime.sh` reads
// the vector one element per line and refuses anything outside this set, and
// the contract test pins the same set. A model token that fails it plans fine
// and then kills the run at its first cell, so refuse it at plan time.
export const FINDER_ARGV_ELEMENT = /^[A-Za-z0-9._="@/:-]+$/;

/**
 * Digest over the finder command a pipeline cell actually executes. The
 * contract pins that argument vector, and `run-eval.sh` spawns it element for
 * element, so this is the finder half of the row's provenance.
 *
 * It replaced a digest of `~/.claude/bin/codex-review.sh`. That wrapper is an
 * operator convenience no cell ever runs: recording it claimed a drift control
 * the harness did not have, because a wrapper regression could not reach a
 * measured number while an edited `argv` moved every pipeline cell unrecorded.
 */
export function finderArgvDigest(contract) {
  const argv = contract?.sut?.finder?.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("contract sut.finder.argv must be a non-empty array");
  }
  return createHash("sha256")
    .update(JSON.stringify(argv.map(String)))
    .digest("hex");
}

/** Parse a `--finder MODEL@EFFORT` spec. */
export function parseFinderSpec(spec) {
  const value = String(spec ?? "").trim();
  const at = value.lastIndexOf("@");
  const model = at === -1 ? "" : value.slice(0, at);
  const effort = at === -1 ? "" : value.slice(at + 1);
  if (!model || /[\s@]/.test(model)) {
    throw new Error(
      `--finder must be MODEL@EFFORT with a whitespace-free model; got ${JSON.stringify(spec)}`,
    );
  }
  if (!FINDER_ARGV_ELEMENT.test(model)) {
    throw new Error(
      `--finder model must match ${FINDER_ARGV_ELEMENT} — the argv element rule the runtime enforces; got ${JSON.stringify(model)}`,
    );
  }
  if (!FINDER_EFFORTS.includes(effort)) {
    throw new Error(
      `--finder effort must be one of ${FINDER_EFFORTS.join(", ")}; got ${JSON.stringify(effort)}`,
    );
  }
  return { model, effort };
}

/** A contract copy whose finder is the probe's, plus the override it records. */
export function applyFinderOverride({ contract, override }) {
  if (!override) return { contract, override: null };
  const { model, effort } =
    typeof override === "string" ? parseFinderSpec(override) : override;
  const argv = [...(contract?.sut?.finder?.argv ?? [])].map(String);
  const modelAt = argv.indexOf("-m");
  if (modelAt === -1 || modelAt + 1 >= argv.length) {
    throw new Error(
      "contract sut.finder.argv carries no `-m MODEL` element to override",
    );
  }
  argv[modelAt + 1] = model;
  const effortAt = argv.findIndex((element) =>
    /^model_reasoning_effort="/.test(element),
  );
  if (effortAt === -1) {
    throw new Error(
      'contract sut.finder.argv carries no model_reasoning_effort="..." element to override',
    );
  }
  argv[effortAt] = `model_reasoning_effort="${effort}"`;
  return {
    contract: {
      ...contract,
      sut: {
        ...contract.sut,
        finder: { ...contract.sut.finder, model, effort, argv },
      },
    },
    override: { model, effort, argv },
  };
}

/** The contract one plan of this kind runs against, with the two flags paired. */
export function resolveFinderPlan({ contract, kind, finder, baselineRow }) {
  if (finder && kind !== "finder") {
    throw new Error("--finder is only valid with --kind finder");
  }
  if (kind === "finder" && !finder) {
    throw new Error("--kind finder requires --finder MODEL@EFFORT");
  }
  // A probe scores and stops: it resolves no baseline, appends no row and
  // reports nothing, so `--against` would be accepted and then ignored.
  if (kind === "finder" && baselineRow) {
    throw new Error(
      "--against is not valid with --kind finder; a probe resolves no baseline and appends no row",
    );
  }
  return applyFinderOverride({ contract, override: finder });
}

/**
 * The detail-directory segment that separates two probes planned on one day.
 * The rest of the base name — date, comparability key, kind, skill digest — is
 * identical for every probe of a contract, and a finder run appends no ledger
 * row, so without this the second probe would overwrite the first one's
 * evidence in place. The overridden argv digest is exactly what differs.
 */
export function finderDetailSegment({ kind, inputs }) {
  if (kind !== "finder") return "";
  return `-${String(inputs?.finder_argv_digest ?? "").slice(0, 8)}`;
}

/**
 * The detail-directory name a plan takes before `resolveDetailDir` disambiguates
 * it against the ledger. The skill under test and the kind are in it because the
 * directory is also the resume cache: two runs of the same contract with
 * different skills must never land on each other's cells.
 */
export function detailDirBase({ date, key, kind, inputs }) {
  const skill = String(inputs?.skill_digest ?? "").slice(0, 8);
  return `${date}-${String(key).slice(0, 8)}-${kind}-${skill}${finderDetailSegment({ kind, inputs })}`;
}

/** The row verdict of a finder probe: outside the ledger set, so it never appends. */
export function finderProbeDecision() {
  return {
    verdict: "EXPERIMENT",
    reasons: [
      "finder probe: one draw per fixture under a substituted finder; it ranks nothing and appends nothing",
    ],
  };
}
