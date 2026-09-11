// The two substitutions behind `--kind finder`: the finder (`--finder
// MODEL@EFFORT`) and the verifier (`--verifier TOOL:MODEL@EFFORT`).
//
// Each rewrites one half of the probe's pipeline and nothing else. The contract
// on disk never moves, and a substitution reaches the spawned command through
// the plan, so `finder_argv_digest` and `verifier_override` record what ran and
// stop a probe cell from reusing a canonical run's cell. Neither may move the
// comparability key: the key names the contract a probe is read against, and
// keyed on a substitution a probe would start its own lineage and be comparable
// with nothing.

import { createHash } from "node:crypto";

export const FINDER_EFFORTS = ["low", "medium", "high", "xhigh"];

// The rule every finder argv element must satisfy: `run-eval-runtime.sh` reads
// the vector one element per line and refuses anything outside this set, and the
// contract test pins the same set. A model token that fails it plans fine and
// then kills the run at its first cell, so it is refused at plan time.
export const FINDER_ARGV_ELEMENT = /^[A-Za-z0-9._="@/:-]+$/;

/**
 * Digest over the finder command a pipeline cell actually executes. The contract
 * pins that argument vector and `run-eval.sh` spawns it element for element, so
 * this is the finder half of the row's provenance. It replaced a digest of
 * `~/.claude/bin/codex-review.sh`, a wrapper no cell ever runs: recording that
 * claimed a drift control the harness did not have, because an edited `argv`
 * moved every pipeline cell unrecorded.
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
  // A probe scores and stops, so `--against` would be accepted and ignored.
  if (kind === "finder" && baselineRow) {
    throw new Error(
      "--against is not valid with --kind finder; a probe resolves no baseline and appends no row",
    );
  }
  return applyFinderOverride({ contract, override: finder });
}

/**
 * The detail-directory segment that separates two probes planned on one day. The
 * rest of the base name is identical for every probe of a contract, and a probe
 * appends no ledger row, so without this the second would overwrite the first
 * one's evidence in place.
 *
 * Three things go in. The overridden argv is the probe's subject. The two CLI
 * versions are outside the comparability key, so an upgrade between two probes
 * of one finder would leave the name identical while `cellFingerprint` rejected
 * every cell the earlier runtime paid for — a second, partial matrix writing
 * beside the first one's stale root `result-*.json`. A substituted verifier is
 * appended only when there is one. An identical rerun still resumes, because
 * identical inputs give the same digest.
 */
export function finderDetailSegment({ kind, inputs }) {
  if (kind !== "finder") return "";
  const argv = String(inputs?.finder_argv_digest ?? "").slice(0, 8);
  const cli = createHash("sha256")
    .update(
      JSON.stringify([
        String(inputs?.claude_cli ?? ""),
        String(inputs?.codex_cli ?? ""),
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  const verifier = verifierOverrideDigest(inputs?.verifier_override ?? null);
  return `-${argv}-${cli}${verifier ? `-${verifier.slice(0, 8)}` : ""}`;
}

/**
 * The detail-directory name a plan takes before `resolveDetailDir` disambiguates
 * it against the ledger. The skill and the kind are in it because the directory
 * is also the resume cache: two runs of one contract with different skills must
 * never land on each other's cells.
 */
export function detailDirBase({ date, key, kind, inputs }) {
  const skill = String(inputs?.skill_digest ?? "").slice(0, 8);
  return `${date}-${String(key).slice(0, 8)}-${kind}-${skill}${finderDetailSegment({ kind, inputs })}`;
}

// --- the verifier substitution ----------------------------------------------
//
// Valid only with `--kind finder`, for the same reason `--finder` is: a
// canonical row must name the contract's own pipeline. `codex` is the second
// tool because the question the lane asks is whether a bare model reads a
// handoff as well as the skilled verifier does — so a codex verifier runs with
// no skill staged, in a read-only sandbox, and reports no price.

export const VERIFIER_TOOLS = ["claude", "codex"];

/** Parse a `--verifier TOOL:MODEL@EFFORT` spec. */
export function parseVerifierSpec(spec) {
  const value = String(spec ?? "").trim();
  const colon = value.indexOf(":");
  const tool = colon === -1 ? "" : value.slice(0, colon);
  if (!VERIFIER_TOOLS.includes(tool)) {
    throw new Error(
      `--verifier must be TOOL:MODEL@EFFORT with TOOL one of ${VERIFIER_TOOLS.join(", ")}; got ${JSON.stringify(spec)}`,
    );
  }
  const { model, effort } = parseFinderSpec(value.slice(colon + 1));
  return { tool, model, effort };
}

/** The verifier one plan of this kind runs, with the flag pairing enforced. */
export function resolveVerifierOverride({ kind, verifier }) {
  if (!verifier) return null;
  if (kind !== "finder") {
    throw new Error("--verifier is only valid with --kind finder");
  }
  return typeof verifier === "string" ? parseVerifierSpec(verifier) : verifier;
}

/**
 * What separates one probe's cells and detail directory from another's when the
 * two substitute different verifiers. `null` for a plan running the contract's
 * own verifier, which therefore keeps the cell fingerprint and directory name it
 * had before this flag existed.
 */
export function verifierOverrideDigest(override) {
  if (!override) return null;
  const parts = [override.tool, override.model, override.effort].map(String);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The verifier a plan's pipeline cells run: the override, or the contract's. */
export function planVerifier({ contract, override = null }) {
  if (override) return { ...override };
  const { tool = "claude", model, effort } = contract?.sut?.verifier ?? {};
  return { tool, model, effort };
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
