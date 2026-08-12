import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  issue,
  requiredObject,
} from "./europ-operational-admission-contract.mjs";
import {
  deriveApprovedBudget,
  deriveMonotoneSwapEnvelope,
  inspectEvaluation,
  inspectEvidenceIdentity,
} from "./europ-operational-admission-evidence.mjs";
import {
  inspectCustodyBoundary,
  inspectEmergencyHalt,
  inspectRateControl,
  inspectSafe,
  inspectStrategies,
} from "./europ-operational-admission-controls.mjs";
import {
  inspectBoundaryModelClaims,
  inspectCertificate,
  inspectLossBudgetWitness,
  inspectWitnessConfigurationPin,
} from "./europ-operational-admission-witness.mjs";

function permanentBlockers() {
  return [
    issue(
      "EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED",
      "No complete authenticated sequential model maximizes every reachable protected-boundary EURm transition.",
    ),
    issue(
      "SNAPSHOT_NOT_AUTHENTICATED",
      "The checked-in snapshot is diagnostic evidence, not authenticated proof of Safe, rate, strategy, or budget state.",
    ),
    issue(
      "LOCAL_FORK_PROVENANCE_UNATTESTED",
      "Local-fork observations have no independent execution or fork-source attestation and cannot support Live admission.",
    ),
  ];
}

function blockedResult({
  blockers,
  evidenceIdentity = null,
  evaluation = null,
  budget = null,
  monotoneSwapEnvelope = null,
  safeDiagnostics = null,
  rateDiagnostics = null,
  strategyDiagnostics = null,
  certificate = null,
  boundaryModelClaims = null,
  haltDiagnostics = null,
  custodyDiagnostics = null,
  witnessConfiguration = null,
  lossBudgetWitness = null,
}) {
  const approvedBudgetEurmRaw = budget?.approvedBudgetEurmRaw ?? null;
  const unavailableReason =
    "A complete authenticated sequential model is missing, and independent execution and fork-source attestation is missing.";
  const worstCaseBudgetComparison = {
    status: "not_evaluable",
    reason: unavailableReason,
    approvedBudgetEurmRaw,
  };
  return {
    status: "BLOCKED",
    evidenceIdentity,
    evaluation,
    budget,
    monotoneSwapEnvelope,
    safeDiagnostics,
    rateDiagnostics,
    strategyDiagnostics,
    certificate,
    boundaryModelClaims,
    haltDiagnostics,
    custodyDiagnostics,
    witnessConfiguration,
    lossBudgetWitness,
    monotoneCapacityBudgetComparison: {
      status: "not_evaluable",
      reason: unavailableReason,
      approvedBudgetEurmRaw,
    },
    worstCaseBudgetComparison,
    blockers,
  };
}

/**
 * Fail-closed EUROP operational-admission diagnostic. This implementation
 * cannot grant readiness or Live admission. Local-fork claims remain
 * unattested diagnostics until a complete authenticated sequential model and
 * independent execution and fork-source attestation are available.
 */
export function evaluateOperationalAdmission(input) {
  const blockers = permanentBlockers();
  const partial = {
    blockers,
    evidenceIdentity: null,
    evaluation: null,
    budget: null,
    monotoneSwapEnvelope: null,
    safeDiagnostics: null,
    rateDiagnostics: null,
    strategyDiagnostics: null,
    certificate: null,
    boundaryModelClaims: null,
    haltDiagnostics: null,
    custodyDiagnostics: null,
    witnessConfiguration: null,
    lossBudgetWitness: null,
  };

  try {
    const snapshot = requiredObject(input, "snapshot");
    partial.evidenceIdentity = inspectEvidenceIdentity(snapshot, blockers);
    partial.evaluation = inspectEvaluation(snapshot, blockers);
    if (
      partial.evidenceIdentity.protocolIdentity
        .matchesExpectedEuropPolygonIdentity &&
      partial.evidenceIdentity.blockReference.wellFormed
    ) {
      partial.monotoneSwapEnvelope = deriveMonotoneSwapEnvelope(snapshot);
      blockers.push(...partial.monotoneSwapEnvelope.invariantViolations);
    }
    partial.budget = deriveApprovedBudget(snapshot, blockers);
    partial.safeDiagnostics = inspectSafe(snapshot, blockers);
    partial.rateDiagnostics = inspectRateControl(snapshot, blockers);
    partial.strategyDiagnostics = inspectStrategies(snapshot, blockers);
    partial.custodyDiagnostics = inspectCustodyBoundary(snapshot, blockers);
    partial.witnessConfiguration = inspectWitnessConfigurationPin(
      snapshot,
      partial,
      blockers,
    );
    partial.haltDiagnostics = inspectEmergencyHalt(
      snapshot,
      partial.witnessConfiguration,
      blockers,
    );
    partial.lossBudgetWitness = inspectLossBudgetWitness(
      snapshot,
      partial.budget,
      partial.witnessConfiguration,
      blockers,
    );
    partial.certificate = inspectCertificate(
      snapshot,
      partial.evaluation,
      blockers,
    );
    partial.boundaryModelClaims = inspectBoundaryModelClaims(
      snapshot,
      blockers,
    );
  } catch (error) {
    blockers.push(
      issue(
        "INPUT_INVALID",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  return blockedResult(partial);
}

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]),
    );
  }
  return value;
}

async function main(args) {
  const snapshotIndex = args.indexOf("--snapshot");
  if (snapshotIndex < 0 || !args[snapshotIndex + 1]) {
    throw new Error(
      "usage: node scripts/europ-operational-admission.mjs --snapshot <path>",
    );
  }
  const path = resolve(args[snapshotIndex + 1]);
  const proofIndex = args.indexOf("--proof-dir");
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const result = blockedResult({
      blockers: [
        ...permanentBlockers(),
        issue(
          "INPUT_INVALID",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    });
    process.stdout.write(`${JSON.stringify(jsonValue(result), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  if (proofIndex >= 0) {
    const result = evaluateOperationalAdmission(snapshot);
    result.blockers.push(
      issue(
        "LOCAL_FORK_ARTIFACT_IMPORT_UNSUPPORTED",
        "--proof-dir is unsupported because caller-supplied local artifacts cannot attest execution or fork-source provenance.",
      ),
    );
    process.stdout.write(`${JSON.stringify(jsonValue(result), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const result = evaluateOperationalAdmission(snapshot);
  process.stdout.write(`${JSON.stringify(jsonValue(result), null, 2)}\n`);
  if (result.status === "BLOCKED") process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
