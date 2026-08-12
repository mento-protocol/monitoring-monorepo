import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { evaluateOperationalAdmission } from "./europ-operational-admission.mjs";

const fixtureUrl = new URL(
  "./fixtures/europ-operational-admission/2026-08-11.json",
  import.meta.url,
);
const fixturePath = fileURLToPath(fixtureUrl);
const scriptPath = fileURLToPath(
  new URL("./europ-operational-admission.mjs", import.meta.url),
);

async function currentSnapshot() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function blockerCodes(result) {
  return new Set(result.blockers.map((blocker) => blocker.code));
}

function assertUnattested(result) {
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.worstCaseBudgetComparison.status, "not_evaluable");
  assert.match(
    result.worstCaseBudgetComparison.reason,
    /complete authenticated sequential model/u,
  );
  assert.match(
    result.worstCaseBudgetComparison.reason,
    /independent execution and fork-source attestation/u,
  );
  assert.equal(result.lossBudgetWitness.claimStatus, "unattested");
  assert.equal(result.lossBudgetWitness.provenance, "unattested");
  assert.equal(result.haltDiagnostics.localForkClaimStatus, "unattested");
  assert.equal(result.haltDiagnostics.provenance, "unattested");
  assert.ok(blockerCodes(result).has("LOCAL_FORK_PROVENANCE_UNATTESTED"));
}

test("derives canonical six-hour capacity while keeping local-fork claims unattested", async () => {
  const result = evaluateOperationalAdmission(await currentSnapshot());

  assertUnattested(result);
  assert.equal(result.lossBudgetWitness.localForkClaimMatches, true);
  assert.equal(result.haltDiagnostics.localForkClaimMatches, true);
  assert.equal(result.monotoneCapacityBudgetComparison.status, "not_evaluable");
  assert.equal(
    result.monotoneSwapEnvelope.netflowCapacityFixed15,
    750000000000000000000n,
  );
  assert.equal(
    result.monotoneSwapEnvelope.grossInputFixed15,
    750375187593796898449n,
  );
  assert.equal(
    result.monotoneSwapEnvelope.grossMonitoredInputRaw,
    750375187593n,
  );
  assert.deepEqual(
    result.monotoneSwapEnvelope.windows.map((window) => [
      window.name,
      window.resetWindows,
      window.durableCapacityFixed15,
    ]),
    [
      ["L0", 72n, 3700000000000000000000n],
      ["L1", 1n, 750000000000000000000n],
    ],
  );
  assert.equal(
    result.lossBudgetWitness.externalQuoteOutEurmRaw,
    101949000000000000000000n,
  );
});

test("caller-supplied claims and ignored extra arguments cannot unlock a conclusion", async () => {
  const snapshot = await currentSnapshot();
  snapshot.budget.liquidReserveAssetsEurmRaw = "40000000000000000000000000";
  snapshot.controls.rate.enforcedNoChange = true;
  snapshot.controls.strategies = snapshot.controls.strategies.map(
    (strategy) => ({
      ...strategy,
      maxQuoteOutflowEurmRaw: "1",
      mintCapEurmRaw: strategy.kind === "reserve" ? "1" : null,
    }),
  );
  snapshot.boundaryModel = {
    protectedSystemBoundary: "asserted boundary",
    modelId: "asserted-model",
    coversBidirectionalRateTransitions: true,
    coversAllEnabledStrategies: true,
    monotoneCapacityNetQuoteOutflowEurmRaw: "1",
    worstCaseNetQuoteOutflowEurmRaw: "1",
  };

  const result = evaluateOperationalAdmission(snapshot, {});

  assertUnattested(result);
  assert.ok(blockerCodes(result).has("EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED"));
});

test("fails closed on malformed local-fork claims without a validation blocker", async () => {
  const snapshot = await currentSnapshot();
  snapshot.lossBudgetWitness.successfulTransactions = "152";
  snapshot.emergencyHalt.forkProof.reserveRebalanceSuspended = false;

  const result = evaluateOperationalAdmission(snapshot);

  assertUnattested(result);
  assert.equal(result.lossBudgetWitness.localForkClaimMatches, false);
  assert.equal(result.haltDiagnostics.localForkClaimMatches, false);
  assert.ok(blockerCodes(result).has("LOCAL_FORK_WITNESS_CLAIM_MISMATCH"));
  assert.ok(blockerCodes(result).has("LOCAL_FORK_HALT_CLAIM_MISMATCH"));
});

test("fails closed on malformed snapshots", async () => {
  const snapshot = await currentSnapshot();
  snapshot.pool.tradingLimits[0].netflowFixed15 = "not-an-integer";

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("INPUT_INVALID"));
  assert.ok(blockerCodes(result).has("LOCAL_FORK_PROVENANCE_UNATTESTED"));
});

test("CLI rejects proof-directory imports with structured blocked JSON and exit 2", () => {
  const child = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--snapshot",
      fixturePath,
      "--proof-dir",
      "/arbitrary/complete",
    ],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 2, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assertUnattested(result);
  assert.ok(blockerCodes(result).has("LOCAL_FORK_ARTIFACT_IMPORT_UNSUPPORTED"));
});

test("CLI emits structured blocked JSON for snapshot-only and unreadable inputs", () => {
  const snapshotOnly = spawnSync(
    process.execPath,
    [scriptPath, "--snapshot", fixturePath],
    { encoding: "utf8" },
  );
  assert.equal(snapshotOnly.status, 1, snapshotOnly.stderr);
  assertUnattested(JSON.parse(snapshotOnly.stdout));

  const unreadable = spawnSync(
    process.execPath,
    [scriptPath, "--snapshot", `${fixturePath}.missing`],
    { encoding: "utf8" },
  );
  assert.equal(unreadable.status, 2, unreadable.stderr);
  const result = JSON.parse(unreadable.stdout);
  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("INPUT_INVALID"));
  assert.ok(blockerCodes(result).has("LOCAL_FORK_PROVENANCE_UNATTESTED"));
});

test("reports rate, custody, strategy, and pool-state drift as diagnostics", async () => {
  const cases = [
    [
      "rate",
      (snapshot) => {
        snapshot.controls.rate.valueDeltaBreakerBps = 49;
      },
      "RATE_CONTROL_CONFIGURATION_MISMATCH",
      (result) => result.rateDiagnostics.configurationMatches,
    ],
    [
      "custody",
      (snapshot) => {
        snapshot.custodyBoundary.lpCustodySafe.threshold = "3";
      },
      "LP_CUSTODY_BOUNDARY_INVALID",
      (result) => result.custodyDiagnostics.configurationMatches,
    ],
    [
      "strategy",
      (snapshot) => {
        snapshot.controls.strategies[0].cooldownSeconds = 299;
      },
      "STRATEGY_CONFIGURATION_MISMATCH",
      (result) => result.strategyDiagnostics.configurationMatches,
    ],
    [
      "pool state",
      (snapshot) => {
        snapshot.pool.tradingLimits[0].limitFixed15 = "50000000000000000001";
      },
      "LOSS_BUDGET_WITNESS_CONFIGURATION_MISMATCH",
      (result) => result.witnessConfiguration.poolConfigurationMatches,
    ],
  ];

  for (const [, mutate, code, matches] of cases) {
    const snapshot = await currentSnapshot();
    mutate(snapshot);
    const result = evaluateOperationalAdmission(snapshot);
    assertUnattested(result);
    assert.equal(matches(result), false);
    assert.ok(blockerCodes(result).has(code));
  }
});

test("binds the diagnostic witness to the exact budget approver, reference, and ceiling", async () => {
  const cases = [
    [
      (snapshot) => {
        snapshot.budget.approvedBy = "Different reviewer";
      },
      "BUDGET_APPROVAL_EVIDENCE_MISMATCH",
      "approvalEvidenceMatches",
    ],
    [
      (snapshot) => {
        snapshot.budget.approvalReference = "https://example.com/other";
      },
      "BUDGET_APPROVAL_EVIDENCE_MISMATCH",
      "approvalEvidenceMatches",
    ],
    [
      (snapshot) => {
        snapshot.budget.approvedBudgetEurmRaw = "100001000000000000000000";
      },
      "APPROVED_BUDGET_ABOVE_POLICY_CEILING",
      "policyMatches",
    ],
  ];

  for (const [mutate, code, failedField] of cases) {
    const snapshot = await currentSnapshot();
    mutate(snapshot);
    const result = evaluateOperationalAdmission(snapshot);
    assertUnattested(result);
    assert.equal(result.budget[failedField], false);
    assert.equal(result.lossBudgetWitness.localForkClaimMatches, false);
    assert.ok(blockerCodes(result).has(code));
  }
  const result = evaluateOperationalAdmission(await currentSnapshot());
  assert.equal(result.budget.approvedBudgetEurmRaw, 100000000000000000000000n);
  assert.equal(result.budget.approvalEvidenceMatches, true);
});

test("complete-looking snapshot claims never grant readiness", async () => {
  const snapshot = await currentSnapshot();
  snapshot.budget.liquidReserveAssetsEurmRaw = "40000000000000000000000000";
  snapshot.controls.rate.enforcedNoChange = true;
  snapshot.controls.strategies = snapshot.controls.strategies.map(
    (strategy) => ({
      ...strategy,
      maxQuoteOutflowEurmRaw: "1",
      mintCapEurmRaw: strategy.kind === "reserve" ? "1" : null,
    }),
  );
  snapshot.certificate = {
    signerCoverageOwner: "asserted owner",
    escalationRoute: "asserted route",
    executionProof: "asserted proof",
    reviewer: "asserted reviewer",
    signerCoverageExpiresAt: "2027-01-01T00:00:00Z",
    escalationRouteExpiresAt: "2027-01-01T00:00:00Z",
    executionProofExpiresAt: "2027-01-01T00:00:00Z",
    budgetApprovalExpiresAt: "2027-01-01T00:00:00Z",
  };
  snapshot.boundaryModel = {
    protectedSystemBoundary: "asserted boundary",
    modelId: "asserted-model",
    coversBidirectionalRateTransitions: true,
    coversAllEnabledStrategies: true,
    monotoneCapacityNetQuoteOutflowEurmRaw: "1",
    worstCaseNetQuoteOutflowEurmRaw: "1",
  };

  const result = evaluateOperationalAdmission(snapshot);
  assertUnattested(result);
  assert.equal(result.monotoneCapacityBudgetComparison.status, "not_evaluable");
  assert.ok(blockerCodes(result).has("EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED"));
  assert.ok(blockerCodes(result).has("SNAPSHOT_NOT_AUTHENTICATED"));
});

test("accepts signed netflow only within the closed TradingLimitsV2 interval", async () => {
  const base = await currentSnapshot();
  const limit = BigInt(base.pool.tradingLimits[0].limitFixed15);
  for (const [netflow, invalid] of [
    [limit, false],
    [-limit, false],
    [limit + 1n, true],
    [-limit - 1n, true],
  ]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = netflow.toString();
    const result = evaluateOperationalAdmission(snapshot);
    assertUnattested(result);
    assert.equal(
      blockerCodes(result).has("TRADING_LIMIT_INVARIANT_VIOLATION"),
      invalid,
    );
  }
});

test("fails closed on malformed snapshots and ambiguous integer values", async () => {
  const malformed = await currentSnapshot();
  malformed.pool.tradingLimits[0].netflowFixed15 = "not-an-integer";
  for (const snapshot of [null, {}, malformed]) {
    let result;
    assert.doesNotThrow(() => {
      result = evaluateOperationalAdmission(snapshot);
    });
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("INPUT_INVALID"));
  }

  const base = await currentSnapshot();
  for (const value of [
    true,
    false,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    " 1",
    "1 ",
    "+1",
    "01",
    "-0",
    "1.0",
    "1e3",
    "",
  ]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = value;
    assert.ok(
      blockerCodes(evaluateOperationalAdmission(snapshot)).has("INPUT_INVALID"),
    );
  }
  for (const value of ["0", "42", "-42", 0, 42, -42]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = value;
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(blockerCodes(result).has("INPUT_INVALID"), false);
    assert.notEqual(result.monotoneSwapEnvelope, null);
  }
});

test("refuses capacity on identity mismatch or malformed block identity", async () => {
  const base = await currentSnapshot();
  const mutations = [
    (snapshot) => {
      snapshot.evidence.chainId = 1;
    },
    (snapshot) => {
      snapshot.evidence.asset = "USDm";
    },
    (snapshot) => {
      snapshot.pool.address = "0x0000000000000000000000000000000000000001";
    },
    (snapshot) => {
      snapshot.pool.monitoredAsset.decimals = 18;
    },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(base);
    mutate(snapshot);
    const result = evaluateOperationalAdmission(snapshot);
    assert.ok(blockerCodes(result).has("PROTOCOL_IDENTITY_MISMATCH"));
    assert.equal(result.monotoneSwapEnvelope, null);
  }

  const malformedHash = await currentSnapshot();
  malformedHash.evidence.blockHash = "0x1234";
  const hashResult = evaluateOperationalAdmission(malformedHash);
  assert.ok(blockerCodes(hashResult).has("BLOCK_REFERENCE_INVALID"));
  assert.equal(hashResult.monotoneSwapEnvelope, null);

  const malformedNumber = await currentSnapshot();
  malformedNumber.evidence.blockNumber = "091830875";
  const numberResult = evaluateOperationalAdmission(malformedNumber);
  assert.ok(blockerCodes(numberResult).has("INPUT_INVALID"));
  assert.equal(numberResult.monotoneSwapEnvelope, null);
});

test("keeps Safe diagnostics structural and excludes nonce from expected structure", async () => {
  const invalid = await currentSnapshot();
  invalid.controls.safe.threshold = "7";
  const invalidResult = evaluateOperationalAdmission(invalid);
  assertUnattested(invalidResult);
  assert.equal(invalidResult.safeDiagnostics.structurallyValid, false);
  assert.equal(
    invalidResult.safeDiagnostics.matchesExpectedControlStructure,
    false,
  );
  assert.equal(invalidResult.safeDiagnostics.authenticated, false);
  assert.ok(blockerCodes(invalidResult).has("SAFE_STRUCTURE_INVALID"));

  const nonce = await currentSnapshot();
  nonce.controls.safe.nonce = "10";
  const nonceResult = evaluateOperationalAdmission(nonce);
  assert.equal(nonceResult.safeDiagnostics.nonce, 10n);
  assert.equal(
    nonceResult.safeDiagnostics.matchesExpectedControlStructure,
    true,
  );
  assert.equal(
    blockerCodes(nonceResult).has("SAFE_EXPECTED_CONFIGURATION_MISMATCH"),
    false,
  );
});

test("treats alternate valid block references as diagnostic and unattested", async () => {
  const snapshot = await currentSnapshot();
  snapshot.evidence.blockNumber = "91830876";
  snapshot.evidence.blockHash = `0x${"1".repeat(64)}`;

  const result = evaluateOperationalAdmission(snapshot);
  assertUnattested(result);
  assert.equal(result.evidenceIdentity.blockReference.wellFormed, true);
  assert.equal(result.evidenceIdentity.blockReference.authenticated, false);
  assert.equal(result.monotoneSwapEnvelope === null, false);
  assert.equal(result.witnessConfiguration.datedPinMatches, false);
  assert.equal(result.haltDiagnostics.localForkClaimMatches, false);
  assert.ok(blockerCodes(result).has("LOCAL_FORK_HALT_CLAIM_MISMATCH"));
});

test("enforces evidence freshness and strict timestamp syntax", async () => {
  const stale = await currentSnapshot();
  stale.evaluation.maxEvidenceAgeSeconds = "900";
  stale.evaluation.evaluatedAt = "2026-08-11T13:00:00Z";
  assert.ok(
    blockerCodes(evaluateOperationalAdmission(stale)).has("EVIDENCE_STALE"),
  );

  for (const observedAt of [
    "2026-08-11T12:29:00",
    "2026-02-30T12:29:00Z",
    "2026-08-11T12:29:00-00:00",
  ]) {
    const snapshot = await currentSnapshot();
    snapshot.evidence.observedAt = observedAt;
    assert.ok(
      blockerCodes(evaluateOperationalAdmission(snapshot)).has(
        "EVIDENCE_TIMESTAMP_MISSING_OR_INVALID",
      ),
    );
  }
  const offset = await currentSnapshot();
  offset.evidence.observedAt = "2026-08-11T14:29:00+02:00";
  offset.evaluation.evaluatedAt = "2026-08-11T14:35:00+02:00";
  const result = evaluateOperationalAdmission(offset);
  assert.equal(result.evaluation.evidenceAgeSeconds, 360n);
  assert.equal(
    blockerCodes(result).has("EVALUATION_TIMESTAMP_MISSING_OR_INVALID"),
    false,
  );
});

test("enforces certificate expiry and the exact six-hour execution policy", async () => {
  for (const expiry of ["2027-01-01T00:00:00", "2026-02-30T00:00:00Z"]) {
    const snapshot = await currentSnapshot();
    snapshot.certificate.signerCoverageExpiresAt = expiry;
    assert.ok(
      blockerCodes(evaluateOperationalAdmission(snapshot)).has(
        "ATTESTATION_EXPIRY_INVALID",
      ),
    );
  }
  const expired = await currentSnapshot();
  for (const field of [
    "signerCoverageExpiresAt",
    "escalationRouteExpiresAt",
    "executionProofExpiresAt",
    "budgetApprovalExpiresAt",
  ]) {
    expired.certificate[field] = "2026-08-11T12:34:59Z";
  }
  assert.ok(
    blockerCodes(evaluateOperationalAdmission(expired)).has(
      "ATTESTATION_EXPIRED",
    ),
  );

  for (const mutate of [
    (snapshot) => {
      snapshot.certificate.acceptedSafeNonce = "9";
    },
    (snapshot) => {
      snapshot.certificate.acceptedResponseSeconds = "21599";
    },
    (snapshot) => {
      snapshot.certificate.executionElapsedSeconds = "7890";
    },
    (snapshot) => {
      snapshot.certificate.executionWithinResponseTimeAccepted = false;
    },
  ]) {
    const snapshot = await currentSnapshot();
    mutate(snapshot);
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.certificate.policyMatches, false);
    assert.ok(blockerCodes(result).has("CERTIFICATE_POLICY_MISMATCH"));
  }
});
