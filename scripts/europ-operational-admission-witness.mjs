import {
  EXPECTED_CHAIN_ID,
  EXPECTED_EXECUTION_PROOF_REFERENCE,
  EXPECTED_EXECUTION_SECONDS,
  EXPECTED_ESCALATION_ROUTE,
  EXPECTED_MENTO_CORE_COMMIT,
  EXPECTED_MONITORED_RESERVE_RAW,
  EXPECTED_PIN_BLOCK_HASH,
  EXPECTED_PIN_BLOCK_NUMBER,
  EXPECTED_POOL_ADDRESS,
  EXPECTED_PROTOCOL_FEE_RECIPIENT,
  EXPECTED_QUOTE_RESERVE_RAW,
  EXPECTED_RESERVE_STRATEGY,
  EXPECTED_SAFE_ADDRESS,
  EXPECTED_RESPONSE_SECONDS,
  EXPECTED_TRADING_LIMITS,
  EXPECTED_WITNESS_MODEL,
  hasText,
  integer,
  issue,
  matchesAddress,
  nonNegative,
  optionalNonNegative,
  positive,
  requiredArray,
  requiredObject,
  timestamp,
} from "./europ-operational-admission-contract.mjs";

export function inspectWitnessConfigurationPin(
  snapshot,
  {
    evidenceIdentity,
    safeDiagnostics,
    rateDiagnostics,
    strategyDiagnostics,
    custodyDiagnostics,
  },
  blockers,
) {
  const evidence = requiredObject(snapshot.evidence, "snapshot.evidence");
  const pool = requiredObject(snapshot.pool, "snapshot.pool");
  const quoteAsset = requiredObject(
    pool.quoteAsset,
    "snapshot.pool.quoteAsset",
  );
  const monitoredAsset = requiredObject(
    pool.monitoredAsset,
    "snapshot.pool.monitoredAsset",
  );
  const administration = requiredObject(
    pool.administration,
    "snapshot.pool.administration",
  );
  const fee = requiredObject(pool.fee, "snapshot.pool.fee");
  const limits = requiredArray(
    pool.tradingLimits,
    "snapshot.pool.tradingLimits",
  );
  const chainId = nonNegative(evidence.chainId, "evidence.chainId");
  const blockNumber = positive(evidence.blockNumber, "evidence.blockNumber");
  const quoteReserveRaw = nonNegative(
    quoteAsset.reserveRaw,
    "pool.quoteAsset.reserveRaw",
  );
  const monitoredReserveRaw = nonNegative(
    monitoredAsset.reserveRaw,
    "pool.monitoredAsset.reserveRaw",
  );
  const lpFeeBps = nonNegative(fee.lpBps, "pool.fee.lpBps");
  const protocolFeeBps = nonNegative(fee.protocolBps, "pool.fee.protocolBps");
  const rebalanceIncentiveBps = nonNegative(
    pool.rebalanceIncentiveBps,
    "pool.rebalanceIncentiveBps",
  );
  const rebalanceThresholdAboveBps = nonNegative(
    pool.rebalanceThresholdAboveBps,
    "pool.rebalanceThresholdAboveBps",
  );
  const rebalanceThresholdBelowBps = nonNegative(
    pool.rebalanceThresholdBelowBps,
    "pool.rebalanceThresholdBelowBps",
  );
  const datedPinMatches =
    chainId === EXPECTED_CHAIN_ID &&
    blockNumber === EXPECTED_PIN_BLOCK_NUMBER &&
    hasText(evidence.blockHash) &&
    evidence.blockHash.toLowerCase() === EXPECTED_PIN_BLOCK_HASH;
  const tradingLimitsMatch =
    limits.length === EXPECTED_TRADING_LIMITS.length &&
    limits.every((value, index) => {
      const limit = requiredObject(value, `pool.tradingLimits[${index}]`);
      const expected = EXPECTED_TRADING_LIMITS[index];
      return (
        limit.name === expected.name &&
        nonNegative(
          limit.limitFixed15,
          `pool.tradingLimits[${index}].limitFixed15`,
        ) === expected.limitFixed15 &&
        positive(
          limit.durationSeconds,
          `pool.tradingLimits[${index}].durationSeconds`,
        ) === expected.durationSeconds &&
        integer(
          limit.netflowFixed15,
          `pool.tradingLimits[${index}].netflowFixed15`,
        ) === expected.netflowFixed15 &&
        nonNegative(
          limit.lastUpdated,
          `pool.tradingLimits[${index}].lastUpdated`,
        ) === expected.lastUpdated
      );
    });
  const poolConfigurationMatches =
    quoteReserveRaw === EXPECTED_QUOTE_RESERVE_RAW &&
    monitoredReserveRaw === EXPECTED_MONITORED_RESERVE_RAW &&
    lpFeeBps === 3n &&
    protocolFeeBps === 2n &&
    rebalanceIncentiveBps === 1n &&
    rebalanceThresholdAboveBps === 5_000n &&
    rebalanceThresholdBelowBps === 3_333n &&
    tradingLimitsMatch;
  const boundaryAdministrationMatches =
    matchesAddress(administration.owner, EXPECTED_SAFE_ADDRESS) &&
    matchesAddress(administration.feeSetter, EXPECTED_SAFE_ADDRESS) &&
    matchesAddress(
      administration.protocolFeeRecipient,
      EXPECTED_PROTOCOL_FEE_RECIPIENT,
    );
  const protocolIdentityMatches =
    evidenceIdentity?.protocolIdentity?.matchesExpectedEuropPolygonIdentity ===
    true;
  const safeConfigurationMatches =
    safeDiagnostics?.structurallyValid === true &&
    safeDiagnostics?.matchesExpectedControlStructure === true;
  const rateConfigurationMatches =
    rateDiagnostics?.configurationMatches === true;
  const strategyConfigurationMatches =
    strategyDiagnostics?.enumerationClaim === true &&
    strategyDiagnostics?.configurationMatches === true;
  const custodyConfigurationMatches =
    custodyDiagnostics?.configurationMatches === true;
  const applicable =
    datedPinMatches &&
    protocolIdentityMatches &&
    poolConfigurationMatches &&
    boundaryAdministrationMatches &&
    safeConfigurationMatches &&
    rateConfigurationMatches &&
    strategyConfigurationMatches &&
    custodyConfigurationMatches;

  if (!applicable) {
    blockers.push(
      issue(
        "LOSS_BUDGET_WITNESS_CONFIGURATION_MISMATCH",
        "The dated fork witness does not match the exact pinned block, pool state, administration, fee recipient, Safe, rate control, enabled strategies, or reviewed custody boundary.",
      ),
    );
  }

  return {
    datedPinMatches,
    protocolIdentityMatches,
    poolConfigurationMatches,
    boundaryAdministrationMatches,
    safeConfigurationMatches,
    rateConfigurationMatches,
    strategyConfigurationMatches,
    custodyConfigurationMatches,
    applicable,
    authenticated: false,
  };
}

export function inspectLossBudgetWitness(
  snapshot,
  budget,
  witnessConfiguration,
  blockers,
) {
  const witness = requiredObject(
    snapshot.lossBudgetWitness,
    "snapshot.lossBudgetWitness",
  );
  const evidenceBlockNumber = positive(
    requiredObject(snapshot.evidence, "snapshot.evidence").blockNumber,
    "evidence.blockNumber",
  );
  const responseSeconds = positive(snapshot.responseSeconds, "responseSeconds");
  const blockNumber = positive(
    witness.blockNumber,
    "lossBudgetWitness.blockNumber",
  );
  const blockHashMatches =
    hasText(witness.blockHash) &&
    witness.blockHash.toLowerCase() === EXPECTED_PIN_BLOCK_HASH;
  const cycles = positive(witness.cycles, "lossBudgetWitness.cycles");
  const transactionsPerCycle = positive(
    witness.transactionsPerCycle,
    "lossBudgetWitness.transactionsPerCycle",
  );
  const successfulTransactions = positive(
    witness.successfulTransactions,
    "lossBudgetWitness.successfulTransactions",
  );
  const successfulReserveRebalances = positive(
    witness.successfulReserveRebalances,
    "lossBudgetWitness.successfulReserveRebalances",
  );
  const monitoredInputPerCycleRaw = positive(
    witness.monitoredInputPerCycleRaw,
    "lossBudgetWitness.monitoredInputPerCycleRaw",
  );
  const quoteOutPerCycleEurmRaw = positive(
    witness.quoteOutPerCycleEurmRaw,
    "lossBudgetWitness.quoteOutPerCycleEurmRaw",
  );
  const totalMonitoredInputRaw = positive(
    witness.totalMonitoredInputRaw,
    "lossBudgetWitness.totalMonitoredInputRaw",
  );
  const externalQuoteOutEurmRaw = positive(
    witness.externalQuoteOutEurmRaw,
    "lossBudgetWitness.externalQuoteOutEurmRaw",
  );
  const elapsedSeconds = positive(
    witness.elapsedSeconds,
    "lossBudgetWitness.elapsedSeconds",
  );
  const expectedTransactions = cycles * transactionsPerCycle;
  const approvedBudgetEurmRaw = budget?.approvedBudgetEurmRaw ?? null;
  const arithmeticAndConfigurationMatch =
    witness.modelId === EXPECTED_WITNESS_MODEL &&
    witness.mentoCoreCommit === EXPECTED_MENTO_CORE_COMMIT &&
    matchesAddress(witness.pool, EXPECTED_POOL_ADDRESS) &&
    matchesAddress(witness.reserveStrategy, EXPECTED_RESERVE_STRATEGY) &&
    blockNumber === evidenceBlockNumber &&
    blockNumber === EXPECTED_PIN_BLOCK_NUMBER &&
    blockHashMatches &&
    witnessConfiguration?.applicable === true &&
    cycles === 51n &&
    transactionsPerCycle === 3n &&
    successfulTransactions === expectedTransactions &&
    successfulReserveRebalances === cycles &&
    monitoredInputPerCycleRaw === 2_000_000_000n &&
    totalMonitoredInputRaw === cycles * monitoredInputPerCycleRaw &&
    quoteOutPerCycleEurmRaw === 1_999_000_000_000_000_000_000n &&
    externalQuoteOutEurmRaw === cycles * quoteOutPerCycleEurmRaw &&
    elapsedSeconds === 15_080n &&
    elapsedSeconds <= responseSeconds &&
    witness.allTransactionsSucceeded === true &&
    witness.localForkOnly === true &&
    witness.productionActivity === false &&
    approvedBudgetEurmRaw !== null &&
    budget?.policyMatches === true &&
    budget?.approvalEvidenceMatches === true &&
    externalQuoteOutEurmRaw > approvedBudgetEurmRaw;

  if (!arithmeticAndConfigurationMatch) {
    blockers.push(
      issue(
        "LOCAL_FORK_WITNESS_CLAIM_MISMATCH",
        "The local-fork witness claim does not match the pinned diagnostic inputs or its stated arithmetic.",
      ),
    );
  }

  return {
    modelId: witness.modelId ?? null,
    blockNumber,
    blockHash: witness.blockHash ?? null,
    cycles,
    successfulTransactions,
    successfulReserveRebalances,
    monitoredInputPerCycleRaw,
    totalMonitoredInputRaw,
    quoteOutPerCycleEurmRaw,
    externalQuoteOutEurmRaw,
    elapsedSeconds,
    localForkClaimMatches: arithmeticAndConfigurationMatch,
    claimStatus: "unattested",
    provenance: "unattested",
    authenticated: false,
  };
}

export function inspectCertificate(snapshot, evaluation, blockers) {
  const certificate = requiredObject(
    snapshot.certificate,
    "snapshot.certificate",
  );
  const responseSeconds = positive(snapshot.responseSeconds, "responseSeconds");
  const acceptedSafeNonce = positive(
    certificate.acceptedSafeNonce,
    "certificate.acceptedSafeNonce",
  );
  const acceptedResponseSeconds = positive(
    certificate.acceptedResponseSeconds,
    "certificate.acceptedResponseSeconds",
  );
  const executionElapsedSeconds = positive(
    certificate.executionElapsedSeconds,
    "certificate.executionElapsedSeconds",
  );
  for (const field of [
    "signerCoverageOwner",
    "escalationRoute",
    "executionProof",
    "reviewer",
  ]) {
    if (!hasText(certificate[field])) {
      blockers.push(
        issue(
          "CERTIFICATE_FIELD_MISSING",
          `Certificate field ${field} is missing.`,
        ),
      );
    }
  }

  const expiries = {};
  const evaluatedAt = timestamp(evaluation?.evaluatedAt);
  for (const field of [
    "signerCoverageExpiresAt",
    "escalationRouteExpiresAt",
    "executionProofExpiresAt",
    "budgetApprovalExpiresAt",
  ]) {
    const expiresAt = timestamp(certificate[field]);
    expiries[field] = certificate[field] ?? null;
    if (!hasText(certificate[field])) {
      blockers.push(
        issue(
          "ATTESTATION_EXPIRY_MISSING",
          `Certificate field ${field} is missing an explicit expiry.`,
        ),
      );
    } else if (expiresAt === null) {
      blockers.push(
        issue(
          "ATTESTATION_EXPIRY_INVALID",
          `Certificate field ${field} has an invalid expiry.`,
        ),
      );
    } else if (evaluatedAt !== null && expiresAt <= evaluatedAt) {
      blockers.push(
        issue(
          "ATTESTATION_EXPIRED",
          `Certificate field ${field} is expired at the explicit evaluation time.`,
        ),
      );
    }
  }

  const policyMatches =
    certificate.signerCoverageOwner === "Philip Paetz" &&
    certificate.signerCoverageBackup === "Bogdan Dumitru" &&
    certificate.reviewer === "Philip Paetz" &&
    certificate.escalationRoute === EXPECTED_ESCALATION_ROUTE &&
    acceptedSafeNonce === 8n &&
    acceptedResponseSeconds === EXPECTED_RESPONSE_SECONDS &&
    responseSeconds === EXPECTED_RESPONSE_SECONDS &&
    executionElapsedSeconds === EXPECTED_EXECUTION_SECONDS &&
    executionElapsedSeconds <= acceptedResponseSeconds &&
    certificate.executionWithinResponseTimeAccepted === true &&
    certificate.executionProofReference === EXPECTED_EXECUTION_PROOF_REFERENCE;
  if (!policyMatches) {
    blockers.push(
      issue(
        "CERTIFICATE_POLICY_MISMATCH",
        "The signer owner, backup, reviewer, @support-engineer route, six-hour response time, accepted Safe nonce 8 execution, or proof reference differs from the approved certificate.",
      ),
    );
  }

  return {
    signerCoverageOwner: certificate.signerCoverageOwner ?? null,
    signerCoverageBackup: certificate.signerCoverageBackup ?? null,
    reviewer: certificate.reviewer ?? null,
    acceptedSafeNonce,
    acceptedResponseSeconds,
    executionElapsedSeconds,
    executionWithinResponseTimeAccepted:
      certificate.executionWithinResponseTimeAccepted === true,
    executionProofReference: certificate.executionProofReference ?? null,
    policyMatches,
    expiries,
    authenticated: false,
  };
}

export function inspectBoundaryModelClaims(snapshot, blockers) {
  const model = requiredObject(
    snapshot.boundaryModel,
    "snapshot.boundaryModel",
  );
  const monotoneCapacityNetQuoteOutflowClaimEurmRaw = optionalNonNegative(
    model.monotoneCapacityNetQuoteOutflowEurmRaw,
    "boundaryModel.monotoneCapacityNetQuoteOutflowEurmRaw",
  );
  const worstCaseNetQuoteOutflowClaimEurmRaw = optionalNonNegative(
    model.worstCaseNetQuoteOutflowEurmRaw,
    "boundaryModel.worstCaseNetQuoteOutflowEurmRaw",
  );

  if (monotoneCapacityNetQuoteOutflowClaimEurmRaw === null) {
    blockers.push(
      issue(
        "MONOTONE_CAPACITY_QUOTE_BOUND_MISSING",
        "No EURm result is recorded for the documented monotone capacity.",
      ),
    );
  }
  if (worstCaseNetQuoteOutflowClaimEurmRaw === null) {
    blockers.push(
      issue(
        "BOUNDARY_ALIGNED_LOSS_MODEL_MISSING",
        "No worst-case net EURm-outflow result is recorded.",
      ),
    );
  }

  return {
    protectedSystemBoundaryClaim: model.protectedSystemBoundary ?? null,
    modelIdClaim: model.modelId ?? null,
    coversBidirectionalRateTransitionsClaim:
      model.coversBidirectionalRateTransitions === true,
    coversAllEnabledStrategiesClaim: model.coversAllEnabledStrategies === true,
    monotoneCapacityNetQuoteOutflowClaimEurmRaw,
    worstCaseNetQuoteOutflowClaimEurmRaw,
    executable: false,
    authenticated: false,
  };
}
