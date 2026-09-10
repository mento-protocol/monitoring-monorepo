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
export function resolveFinderPlan({ contract, kind, finder }) {
  if (finder && kind !== "finder") {
    throw new Error("--finder is only valid with --kind finder");
  }
  if (kind === "finder" && !finder) {
    throw new Error("--kind finder requires --finder MODEL@EFFORT");
  }
  return applyFinderOverride({ contract, override: finder });
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
