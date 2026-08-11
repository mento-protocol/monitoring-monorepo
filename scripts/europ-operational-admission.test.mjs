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
const scriptPath = fileURLToPath(
  new URL("./europ-operational-admission.mjs", import.meta.url),
);
const fixturePath = fileURLToPath(fixtureUrl);

async function currentSnapshot() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function blockerCodes(result) {
  return new Set(result.blockers.map((blocker) => blocker.code));
}

test("derives the canonical six-hour TradingLimitsV2 monotone capacity", async () => {
  const result = evaluateOperationalAdmission(await currentSnapshot());
  const envelope = result.monotoneSwapEnvelope;

  assert.equal(result.status, "BLOCKED");
  assert.equal(envelope.netflowCapacityFixed15, 750000000000000000000n);
  assert.equal(envelope.grossInputFixed15, 750375187593796898449n);
  assert.equal(envelope.grossMonitoredInputRaw, 750375187593n);
  assert.deepEqual(envelope.invariantViolations, []);
  assert.deepEqual(
    envelope.windows.map((window) => [
      window.name,
      window.resetWindows,
      window.durableCapacityFixed15,
    ]),
    [
      ["L0", 72n, 3700000000000000000000n],
      ["L1", 1n, 750000000000000000000n],
    ],
  );
});

test("keeps the current pinned evidence explicitly Blocked", async () => {
  const result = evaluateOperationalAdmission(await currentSnapshot());

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.monotoneCapacityBudgetComparison.status, "not_evaluable");
  assert.equal(result.worstCaseBudgetComparison.status, "not_evaluable");
  assert.equal(
    result.evidenceIdentity.protocolIdentity
      .matchesExpectedEuropPolygonIdentity,
    true,
  );
  assert.equal(result.evidenceIdentity.protocolIdentity.authenticated, false);
  assert.equal(result.evidenceIdentity.blockReference.wellFormed, true);
  assert.equal(result.evidenceIdentity.blockReference.authenticated, false);
  assert.equal(result.safeDiagnostics.matchesExpectedControlStructure, true);
  assert.deepEqual(
    blockerCodes(result),
    new Set([
      "EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED",
      "SNAPSHOT_NOT_AUTHENTICATED",
      "APPROVED_BUDGET_MISSING",
      "LIQUID_RESERVE_VALUE_MISSING",
      "RATE_TRANSITION_BOUND_MISSING",
      "STRATEGY_BOUNDARY_MODEL_MISSING",
      "RESERVE_MINT_CAP_MISSING",
      "CERTIFICATE_FIELD_MISSING",
      "ATTESTATION_EXPIRY_MISSING",
      "MONOTONE_CAPACITY_QUOTE_BOUND_MISSING",
      "BOUNDARY_ALIGNED_LOSS_MODEL_MISSING",
    ]),
  );
});

test("CLI exits 1 and prints JSON for a valid-but-Blocked snapshot", () => {
  const child = spawnSync(
    process.execPath,
    [scriptPath, "--snapshot", fixturePath],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).status, "BLOCKED");
});

test("CLI preserves exit 2 and structured JSON for an unreadable snapshot", () => {
  const child = spawnSync(
    process.execPath,
    [scriptPath, "--snapshot", `${fixturePath}.missing`],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 2);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("INPUT_INVALID"));
});

test("arbitrary complete-looking claims cannot grant readiness", async () => {
  const snapshot = await currentSnapshot();
  snapshot.budget.liquidReserveAssetsEurmRaw = "40000000000000000000000000";
  snapshot.budget.approvedBudgetEurmRaw = "100000000000000000000000";
  snapshot.budget.approvedBy = "asserted treasury owner";
  snapshot.budget.approvalReference = "asserted approval";
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

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.monotoneCapacityBudgetComparison.status, "not_evaluable");
  assert.equal(result.worstCaseBudgetComparison.status, "not_evaluable");
  assert.ok(blockerCodes(result).has("EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED"));
  assert.ok(blockerCodes(result).has("SNAPSHOT_NOT_AUTHENTICATED"));
});

test("accepts signed netflow only inside the closed interval [-L, +L]", async () => {
  const base = await currentSnapshot();
  const limit = BigInt(base.pool.tradingLimits[0].limitFixed15);

  for (const netflow of [limit, -limit]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = netflow.toString();
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.equal(
      blockerCodes(result).has("TRADING_LIMIT_INVARIANT_VIOLATION"),
      false,
    );
  }

  for (const netflow of [limit + 1n, -limit - 1n]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = netflow.toString();
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("TRADING_LIMIT_INVARIANT_VIOLATION"));
  }
});

test("returns structured Blocked results for malformed snapshots", async () => {
  const malformedInteger = await currentSnapshot();
  malformedInteger.pool.tradingLimits[0].netflowFixed15 = "not-an-integer";

  for (const snapshot of [null, {}, malformedInteger]) {
    let result;
    assert.doesNotThrow(() => {
      result = evaluateOperationalAdmission(snapshot);
    });
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("INPUT_INVALID"));
    assert.ok(
      blockerCodes(result).has("EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED"),
    );
  }
});

test("rejects ambiguous and lossy integer representations", async () => {
  const base = await currentSnapshot();
  const invalidIntegers = [
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
  ];

  for (const value of invalidIntegers) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = value;
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("INPUT_INVALID"));
  }
});

test("accepts canonical integer strings and safe integer numbers", async () => {
  const base = await currentSnapshot();
  for (const value of ["0", "42", "-42", 0, 42, -42]) {
    const snapshot = structuredClone(base);
    snapshot.pool.tradingLimits[0].netflowFixed15 = value;
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.equal(blockerCodes(result).has("INPUT_INVALID"), false);
    assert.notEqual(result.monotoneSwapEnvelope, null);
  }
});

test("refuses to calculate capacity for a mismatched evidence identity", async () => {
  const base = await currentSnapshot();
  const mutations = [
    (snapshot) => {
      snapshot.evidence.chainId = 1;
    },
    (snapshot) => {
      snapshot.evidence.asset = "USDm";
    },
    (snapshot) => {
      snapshot.evidence.quoteAsset = "USDm";
    },
    (snapshot) => {
      snapshot.pool.address = "0x0000000000000000000000000000000000000001";
    },
    (snapshot) => {
      snapshot.pool.quoteAsset.address =
        "0x0000000000000000000000000000000000000002";
    },
    (snapshot) => {
      snapshot.pool.monitoredAsset.decimals = 18;
    },
  ];

  for (const mutate of mutations) {
    const snapshot = structuredClone(base);
    mutate(snapshot);
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("PROTOCOL_IDENTITY_MISMATCH"));
    assert.equal(
      result.evidenceIdentity.protocolIdentity
        .matchesExpectedEuropPolygonIdentity,
      false,
    );
    assert.equal(result.monotoneSwapEnvelope, null);
  }
});

test("rejects malformed block identity before calculating capacity", async () => {
  const malformedHash = await currentSnapshot();
  malformedHash.evidence.blockHash = "0x1234";
  const hashResult = evaluateOperationalAdmission(malformedHash);
  assert.equal(hashResult.status, "BLOCKED");
  assert.ok(blockerCodes(hashResult).has("BLOCK_REFERENCE_INVALID"));
  assert.equal(hashResult.evidenceIdentity.blockReference.wellFormed, false);
  assert.equal(hashResult.monotoneSwapEnvelope, null);

  const noncanonicalBlock = await currentSnapshot();
  noncanonicalBlock.evidence.blockNumber = "091830875";
  const blockResult = evaluateOperationalAdmission(noncanonicalBlock);
  assert.equal(blockResult.status, "BLOCKED");
  assert.ok(blockerCodes(blockResult).has("INPUT_INVALID"));
  assert.equal(blockResult.monotoneSwapEnvelope, null);
});

test("validates Safe structure for diagnostics without authenticating it", async () => {
  const snapshot = await currentSnapshot();
  snapshot.controls.safe.threshold = "7";

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("SAFE_STRUCTURE_INVALID"));
  assert.ok(blockerCodes(result).has("SAFE_EXPECTED_CONFIGURATION_MISMATCH"));
  assert.equal(result.safeDiagnostics.structurallyValid, false);
  assert.equal(result.safeDiagnostics.matchesExpectedControlStructure, false);
  assert.equal(result.safeDiagnostics.authenticated, false);
});

test("reports Safe nonce without including it in expected control structure", async () => {
  const snapshot = await currentSnapshot();
  snapshot.controls.safe.nonce = "10";

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.safeDiagnostics.nonce, 10n);
  assert.equal(result.safeDiagnostics.matchesExpectedControlStructure, true);
  assert.equal(result.safeDiagnostics.authenticated, false);
  assert.equal(
    blockerCodes(result).has("SAFE_EXPECTED_CONFIGURATION_MISMATCH"),
    false,
  );
});

test("treats an alternate valid block reference as well-formed but unauthenticated", async () => {
  const snapshot = await currentSnapshot();
  snapshot.evidence.blockNumber = "91830876";
  snapshot.evidence.blockHash =
    "0x1111111111111111111111111111111111111111111111111111111111111111";

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.equal(
    result.evidenceIdentity.protocolIdentity
      .matchesExpectedEuropPolygonIdentity,
    true,
  );
  assert.equal(result.evidenceIdentity.blockReference.wellFormed, true);
  assert.equal(result.evidenceIdentity.blockReference.authenticated, false);
  assert.equal(result.evidenceIdentity.blockReference.blockNumber, 91830876n);
  assert.equal(
    result.evidenceIdentity.blockReference.blockHash,
    snapshot.evidence.blockHash,
  );
  assert.equal(
    Object.hasOwn(result.evidenceIdentity, "matchesExpected"),
    false,
  );
  assert.notEqual(result.monotoneSwapEnvelope, null);
});

test("fails stale evidence against explicit evaluation time and maximum age", async () => {
  const snapshot = await currentSnapshot();
  snapshot.evaluation.evaluatedAt = "2026-08-11T13:00:00Z";

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("EVIDENCE_STALE"));
});

test("requires strict ISO-8601 timestamps with an explicit UTC offset", async () => {
  for (const observedAt of [
    "2026-08-11T12:29:00",
    "2026-02-30T12:29:00Z",
    "2026-08-11T12:29:00-00:00",
  ]) {
    const snapshot = await currentSnapshot();
    snapshot.evidence.observedAt = observedAt;
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.ok(
      blockerCodes(result).has("EVIDENCE_TIMESTAMP_MISSING_OR_INVALID"),
    );
  }

  const explicitOffset = await currentSnapshot();
  explicitOffset.evidence.observedAt = "2026-08-11T14:29:00+02:00";
  explicitOffset.evaluation.evaluatedAt = "2026-08-11T14:35:00+02:00";
  const validResult = evaluateOperationalAdmission(explicitOffset);
  assert.equal(
    blockerCodes(validResult).has("EVIDENCE_TIMESTAMP_MISSING_OR_INVALID"),
    false,
  );
  assert.equal(
    blockerCodes(validResult).has("EVALUATION_TIMESTAMP_MISSING_OR_INVALID"),
    false,
  );
  assert.equal(validResult.evaluation.evidenceAgeSeconds, 360n);
});

test("rejects timezone-less and normalized-invalid certificate expiries", async () => {
  for (const expiry of ["2027-01-01T00:00:00", "2026-02-30T00:00:00Z"]) {
    const snapshot = await currentSnapshot();
    snapshot.certificate.signerCoverageExpiresAt = expiry;
    const result = evaluateOperationalAdmission(snapshot);
    assert.equal(result.status, "BLOCKED");
    assert.ok(blockerCodes(result).has("ATTESTATION_EXPIRY_INVALID"));
  }
});

test("compares certificate expiry with explicit evaluation time", async () => {
  const snapshot = await currentSnapshot();
  snapshot.certificate = {
    signerCoverageOwner: "Philip Paetz",
    escalationRoute: "@support-engineer",
    executionProof: "accepted Safe execution",
    reviewer: "independent reviewer",
    signerCoverageExpiresAt: "2026-08-11T12:34:59Z",
    escalationRouteExpiresAt: "2026-08-11T12:34:59Z",
    executionProofExpiresAt: "2026-08-11T12:34:59Z",
    budgetApprovalExpiresAt: "2026-08-11T12:34:59Z",
  };

  const result = evaluateOperationalAdmission(snapshot);

  assert.equal(result.status, "BLOCKED");
  assert.ok(blockerCodes(result).has("ATTESTATION_EXPIRED"));
});
