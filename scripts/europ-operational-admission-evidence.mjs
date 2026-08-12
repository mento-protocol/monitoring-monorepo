import {
  ADDRESS_PATTERN,
  BASIS_POINTS,
  BLOCK_HASH_PATTERN,
  EXPECTED_BUDGET_APPROVAL_REFERENCE,
  EXPECTED_BUDGET_APPROVER,
  EXPECTED_CHAIN_ID,
  EXPECTED_MONITORED_TOKEN_ADDRESS,
  EXPECTED_MONITORED_TOKEN_DECIMALS,
  EXPECTED_POOL_ADDRESS,
  EXPECTED_QUOTE_TOKEN_ADDRESS,
  EXPECTED_QUOTE_TOKEN_DECIMALS,
  FIXED_15,
  MAX_BUDGET_EURM_RAW,
  ceilDiv,
  hasText,
  integer,
  issue,
  min,
  nonNegative,
  optionalNonNegative,
  positive,
  requiredArray,
  requiredObject,
  timestamp,
} from "./europ-operational-admission-contract.mjs";

export function inspectEvidenceIdentity(snapshot, blockers) {
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
  const chainId = nonNegative(evidence.chainId, "evidence.chainId");
  const blockNumber = positive(evidence.blockNumber, "evidence.blockNumber");
  const quoteAssetDecimals = nonNegative(
    quoteAsset.decimals,
    "pool.quoteAsset.decimals",
  );
  const monitoredAssetDecimals = nonNegative(
    monitoredAsset.decimals,
    "pool.monitoredAsset.decimals",
  );
  const poolMonitoredAssetDecimals = nonNegative(
    pool.monitoredAssetDecimals,
    "pool.monitoredAssetDecimals",
  );

  const blockReferenceWellFormed =
    hasText(evidence.blockHash) && BLOCK_HASH_PATTERN.test(evidence.blockHash);
  if (!blockReferenceWellFormed) {
    blockers.push(
      issue(
        "BLOCK_REFERENCE_INVALID",
        "The block reference must contain a positive canonical block number and 32-byte hash.",
      ),
    );
  }

  const invalidProtocolFields = [];
  for (const [field, value] of [
    ["pool.address", pool.address],
    ["pool.quoteAsset.address", quoteAsset.address],
    ["pool.monitoredAsset.address", monitoredAsset.address],
  ]) {
    if (!hasText(value) || !ADDRESS_PATTERN.test(value))
      invalidProtocolFields.push(field);
  }
  for (const [field, value] of [
    ["evidence.asset", evidence.asset],
    ["evidence.quoteAsset", evidence.quoteAsset],
    ["pool.quoteAsset.symbol", quoteAsset.symbol],
    ["pool.monitoredAsset.symbol", monitoredAsset.symbol],
  ]) {
    if (!hasText(value)) invalidProtocolFields.push(field);
  }

  if (invalidProtocolFields.length > 0) {
    blockers.push(
      issue(
        "PROTOCOL_IDENTITY_INVALID",
        `Protocol identity fields are malformed: ${invalidProtocolFields.join(", ")}.`,
      ),
    );
  }

  const mismatches = [];
  if (chainId !== EXPECTED_CHAIN_ID) mismatches.push("chainId");
  if (evidence.asset !== "EUROP") mismatches.push("asset");
  if (evidence.quoteAsset !== "EURm") mismatches.push("quoteAsset");
  if (
    hasText(pool.address) &&
    pool.address.toLowerCase() !== EXPECTED_POOL_ADDRESS
  ) {
    mismatches.push("pool.address");
  }
  if (
    hasText(quoteAsset.address) &&
    quoteAsset.address.toLowerCase() !== EXPECTED_QUOTE_TOKEN_ADDRESS
  ) {
    mismatches.push("pool.quoteAsset.address");
  }
  if (
    hasText(monitoredAsset.address) &&
    monitoredAsset.address.toLowerCase() !== EXPECTED_MONITORED_TOKEN_ADDRESS
  ) {
    mismatches.push("pool.monitoredAsset.address");
  }
  if (quoteAsset.symbol !== "EURm") mismatches.push("pool.quoteAsset.symbol");
  if (monitoredAsset.symbol !== "EUROP") {
    mismatches.push("pool.monitoredAsset.symbol");
  }
  if (quoteAssetDecimals !== EXPECTED_QUOTE_TOKEN_DECIMALS) {
    mismatches.push("pool.quoteAsset.decimals");
  }
  if (
    monitoredAssetDecimals !== EXPECTED_MONITORED_TOKEN_DECIMALS ||
    poolMonitoredAssetDecimals !== EXPECTED_MONITORED_TOKEN_DECIMALS
  ) {
    mismatches.push("pool.monitoredAsset.decimals");
  }

  if (mismatches.length > 0) {
    blockers.push(
      issue(
        "PROTOCOL_IDENTITY_MISMATCH",
        `Snapshot identity does not match EUROP/EURm on Polygon: ${mismatches.join(", ")}.`,
      ),
    );
  }

  const matchesExpectedEuropPolygonIdentity =
    invalidProtocolFields.length === 0 && mismatches.length === 0;
  return {
    protocolIdentity: {
      chainId,
      asset: evidence.asset ?? null,
      quoteAsset: evidence.quoteAsset ?? null,
      poolAddress: pool.address ?? null,
      quoteAssetAddress: quoteAsset.address ?? null,
      monitoredAssetAddress: monitoredAsset.address ?? null,
      quoteAssetDecimals,
      monitoredAssetDecimals,
      matchesExpectedEuropPolygonIdentity,
      authenticated: false,
    },
    blockReference: {
      blockNumber,
      blockHash: evidence.blockHash ?? null,
      wellFormed: blockReferenceWellFormed,
      authenticated: false,
    },
  };
}

/**
 * Derive the durable TradingLimitsV2 capacity documented in the canonical
 * onboarding runbook. This is a fee-adjusted monitored-token netflow envelope,
 * not a quote-asset loss result.
 */
export function deriveMonotoneSwapEnvelope(input) {
  const snapshot = requiredObject(input, "snapshot");
  const pool = requiredObject(snapshot.pool, "snapshot.pool");
  const responseSeconds = positive(snapshot.responseSeconds, "responseSeconds");
  const monitoredAssetDecimals = Number(
    nonNegative(pool.monitoredAssetDecimals, "pool.monitoredAssetDecimals"),
  );
  if (!Number.isSafeInteger(monitoredAssetDecimals)) {
    throw new Error("pool.monitoredAssetDecimals must be a safe integer");
  }

  const fee = requiredObject(pool.fee, "pool.fee");
  const totalFeeBps =
    nonNegative(fee.lpBps, "pool.fee.lpBps") +
    nonNegative(fee.protocolBps, "pool.fee.protocolBps");
  if (totalFeeBps >= BASIS_POINTS) {
    throw new Error("pool total fee must be below 10,000 bps");
  }

  const invariantViolations = [];
  const windows = requiredArray(pool.tradingLimits, "pool.tradingLimits")
    .map((window, index) => {
      const parsed = requiredObject(window, `pool.tradingLimits[${index}]`);
      const limitFixed15 = nonNegative(
        parsed.limitFixed15,
        `pool.tradingLimits[${index}].limitFixed15`,
      );
      const durationSeconds = positive(
        parsed.durationSeconds,
        `pool.tradingLimits[${index}].durationSeconds`,
      );
      const netflowFixed15 = integer(
        parsed.netflowFixed15,
        `pool.tradingLimits[${index}].netflowFixed15`,
      );
      if (limitFixed15 === 0n) return null;

      const name = hasText(parsed.name) ? parsed.name : `window-${index}`;
      const withinInvariant =
        netflowFixed15 >= -limitFixed15 && netflowFixed15 <= limitFixed15;
      if (!withinInvariant) {
        invariantViolations.push(
          issue(
            "TRADING_LIMIT_INVARIANT_VIOLATION",
            `${name} signed netflow is outside the enforced interval [-L, +L].`,
          ),
        );
      }

      const resetWindows = ceilDiv(responseSeconds, durationSeconds);
      return {
        name,
        durationSeconds,
        limitFixed15,
        netflowFixed15,
        withinInvariant,
        resetWindows,
        durableCapacityFixed15: 2n * limitFixed15 + limitFixed15 * resetWindows,
      };
    })
    .filter((window) => window !== null);

  if (windows.length === 0) {
    throw new Error("at least one positive TradingLimitsV2 window is required");
  }

  const netflowCapacityFixed15 = min(
    windows.map((window) => window.durableCapacityFixed15),
  );
  const grossInputFixed15 =
    (netflowCapacityFixed15 * BASIS_POINTS) / (BASIS_POINTS - totalFeeBps);

  let grossMonitoredInputRaw = null;
  if (monitoredAssetDecimals <= 15) {
    const fixed15PerMonitoredTokenRaw =
      FIXED_15 / 10n ** BigInt(monitoredAssetDecimals);
    grossMonitoredInputRaw = grossInputFixed15 / fixed15PerMonitoredTokenRaw;
  }

  return {
    responseSeconds,
    totalFeeBps,
    monitoredAssetDecimals,
    windows,
    invariantViolations,
    netflowCapacityFixed15,
    grossInputFixed15,
    grossMonitoredInputRaw,
  };
}

export function inspectEvaluation(snapshot, blockers) {
  const evidence = requiredObject(snapshot.evidence, "snapshot.evidence");
  const evaluation = requiredObject(snapshot.evaluation, "snapshot.evaluation");
  const observedAt = timestamp(evidence.observedAt);
  const evaluatedAt = timestamp(evaluation.evaluatedAt);
  const maxEvidenceAgeSeconds = positive(
    evaluation.maxEvidenceAgeSeconds,
    "evaluation.maxEvidenceAgeSeconds",
  );

  if (observedAt === null) {
    blockers.push(
      issue(
        "EVIDENCE_TIMESTAMP_MISSING_OR_INVALID",
        "The pinned evidence timestamp is absent or invalid.",
      ),
    );
  }
  if (evaluatedAt === null) {
    blockers.push(
      issue(
        "EVALUATION_TIMESTAMP_MISSING_OR_INVALID",
        "The explicit evaluation timestamp is absent or invalid.",
      ),
    );
  }

  let evidenceAgeSeconds = null;
  if (observedAt !== null && evaluatedAt !== null) {
    evidenceAgeSeconds = BigInt(Math.floor((evaluatedAt - observedAt) / 1000));
    if (evidenceAgeSeconds < 0n) {
      blockers.push(
        issue(
          "EVIDENCE_FROM_FUTURE",
          "The pinned evidence timestamp is later than the explicit evaluation time.",
        ),
      );
    } else if (evidenceAgeSeconds > maxEvidenceAgeSeconds) {
      blockers.push(
        issue(
          "EVIDENCE_STALE",
          "The pinned evidence is older than the explicit maximum evidence age.",
        ),
      );
    }
  }

  return {
    observedAt: evidence.observedAt ?? null,
    evaluatedAt: evaluation.evaluatedAt ?? null,
    maxEvidenceAgeSeconds,
    evidenceAgeSeconds,
  };
}

export function deriveApprovedBudget(snapshot, blockers) {
  const budget = requiredObject(snapshot.budget, "snapshot.budget");
  const liquidReserveAssetsEurmRaw = optionalNonNegative(
    budget.liquidReserveAssetsEurmRaw,
    "budget.liquidReserveAssetsEurmRaw",
  );
  const approvedBudgetEurmRaw = optionalNonNegative(
    budget.approvedBudgetEurmRaw,
    "budget.approvedBudgetEurmRaw",
  );
  const approvalEvidencePresent =
    hasText(budget.approvedBy) && hasText(budget.approvalReference);
  const approvalEvidenceMatches =
    budget.approvedBy === EXPECTED_BUDGET_APPROVER &&
    budget.approvalReference === EXPECTED_BUDGET_APPROVAL_REFERENCE;
  const policyMatches =
    budget.rule === "fixed 100,000 EURm loss budget" &&
    liquidReserveAssetsEurmRaw === null &&
    approvedBudgetEurmRaw === MAX_BUDGET_EURM_RAW;

  if (approvedBudgetEurmRaw === null) {
    blockers.push(
      issue("APPROVED_BUDGET_MISSING", "The exact numeric B is absent."),
    );
  } else if (approvedBudgetEurmRaw > MAX_BUDGET_EURM_RAW) {
    blockers.push(
      issue(
        "APPROVED_BUDGET_ABOVE_POLICY_CEILING",
        "The approved budget exceeds the 100,000 EURm policy ceiling.",
      ),
    );
  } else if (!approvalEvidencePresent) {
    blockers.push(
      issue(
        "BUDGET_APPROVAL_EVIDENCE_MISSING",
        "The recorded B lacks its accountable approver or approval reference.",
      ),
    );
  } else if (!approvalEvidenceMatches) {
    blockers.push(
      issue(
        "BUDGET_APPROVAL_EVIDENCE_MISMATCH",
        "The budget approver or issue-comment reference differs from the approved EUROP decision.",
      ),
    );
  }

  if (!policyMatches) {
    blockers.push(
      issue(
        "APPROVED_BUDGET_POLICY_MISMATCH",
        "The recorded policy must be the approved fixed 100,000 EURm loss budget.",
      ),
    );
  }

  if (liquidReserveAssetsEurmRaw === null) {
    if (approvedBudgetEurmRaw === null) {
      blockers.push(
        issue(
          "LIQUID_RESERVE_VALUE_MISSING",
          "No approved liquid-reserve value is available to calculate B from the starter rule.",
        ),
      );
    }
    return {
      liquidReserveAssetsEurmRaw,
      derivedBudgetEurmRaw: null,
      approvedBudgetEurmRaw,
      approvalEvidencePresent,
      approvalEvidenceMatches,
      policyMatches,
    };
  }

  const derivedBudgetEurmRaw = min([
    MAX_BUDGET_EURM_RAW,
    (liquidReserveAssetsEurmRaw * 5n) / 1000n,
  ]);
  if (
    approvedBudgetEurmRaw !== null &&
    approvedBudgetEurmRaw !== derivedBudgetEurmRaw
  ) {
    blockers.push(
      issue(
        "APPROVED_BUDGET_MISMATCH",
        "The recorded B does not equal min(100,000 EURm, 0.5% of the approved liquid-reserve value).",
      ),
    );
  }

  return {
    liquidReserveAssetsEurmRaw,
    derivedBudgetEurmRaw,
    approvedBudgetEurmRaw,
    approvalEvidencePresent,
    approvalEvidenceMatches,
    policyMatches,
  };
}
