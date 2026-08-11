import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASIS_POINTS = 10_000n;
const FIXED_15 = 10n ** 15n;
const MAX_BUDGET_EURM_RAW = 100_000n * 10n ** 18n;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const CANONICAL_INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/u;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/u;
const EXPECTED_CHAIN_ID = 137n;
const EXPECTED_POOL_ADDRESS = "0xcd8c6811d975981f57e7fb32e59f0bee66af3201";
const EXPECTED_QUOTE_TOKEN_ADDRESS =
  "0x4d502d735b4c574b487ed641ae87ceae884731c7";
const EXPECTED_MONITORED_TOKEN_ADDRESS =
  "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51";
const EXPECTED_QUOTE_TOKEN_DECIMALS = 18n;
const EXPECTED_MONITORED_TOKEN_DECIMALS = 6n;
const EXPECTED_SAFE_ADDRESS = "0x58099b74f4acd642da77b4b7966b4138ec5ba458";
const EXPECTED_SAFE_THRESHOLD = 4n;
const EXPECTED_SAFE_OWNER_COUNT = 6n;

function requiredObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function integer(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a safe integer number`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && CANONICAL_INTEGER_PATTERN.test(value)) {
    return BigInt(value);
  }
  throw new Error(
    `${field} must be a canonical integer string or safe integer number`,
  );
}

function nonNegative(value, field) {
  const parsed = integer(value, field);
  if (parsed < 0n) throw new Error(`${field} must be non-negative`);
  return parsed;
}

function positive(value, field) {
  const parsed = nonNegative(value, field);
  if (parsed === 0n) throw new Error(`${field} must be positive`);
  return parsed;
}

function optionalNonNegative(value, field) {
  if (value === null || value === undefined) return null;
  return nonNegative(value, field);
}

function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error(
      "ceilDiv requires a non-negative numerator and positive denominator",
    );
  }
  return (numerator + denominator - 1n) / denominator;
}

function min(values) {
  if (values.length === 0) throw new Error("cannot take minimum of no values");
  return values.reduce((current, value) => (value < current ? value : current));
}

function issue(code, message) {
  return { code, message };
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return days[month - 1] ?? 0;
}

function timestamp(value) {
  if (!hasText(value)) return null;
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText,
    offsetText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = millisecondText ? Number(millisecondText) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (offsetText !== "Z") {
    if (offsetText === "-00:00") return null;
    const offsetHours = Number(offsetText.slice(1, 3));
    const offsetMinutePart = Number(offsetText.slice(4, 6));
    if (
      offsetHours > 14 ||
      offsetMinutePart > 59 ||
      (offsetHours === 14 && offsetMinutePart !== 0)
    ) {
      return null;
    }
    offsetMinutes = offsetHours * 60 + offsetMinutePart;
    if (offsetText.startsWith("-")) offsetMinutes = -offsetMinutes;
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  const parsed = wallClock.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(parsed) ? parsed : null;
}

function permanentBlockers() {
  return [
    issue(
      "EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED",
      "No executable sequential loss model authenticates state, advances every reachable transition, and calculates protected-boundary EURm outflow.",
    ),
    issue(
      "SNAPSHOT_NOT_AUTHENTICATED",
      "The checked-in snapshot is diagnostic evidence, not authenticated proof of Safe, rate, strategy, or budget state.",
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
}) {
  const reason =
    "An executable authenticated sequential loss model is not implemented.";
  const approvedBudgetEurmRaw = budget?.approvedBudgetEurmRaw ?? null;
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
    monotoneCapacityBudgetComparison: {
      status: "not_evaluable",
      reason,
      approvedBudgetEurmRaw,
    },
    worstCaseBudgetComparison: {
      status: "not_evaluable",
      reason,
      approvedBudgetEurmRaw,
    },
    blockers,
  };
}

function inspectEvidenceIdentity(snapshot, blockers) {
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
function deriveMonotoneSwapEnvelope(input) {
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

function inspectEvaluation(snapshot, blockers) {
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

function deriveApprovedBudget(snapshot, blockers) {
  const budget = requiredObject(snapshot.budget, "snapshot.budget");
  const liquidReserveAssetsEurmRaw = optionalNonNegative(
    budget.liquidReserveAssetsEurmRaw,
    "budget.liquidReserveAssetsEurmRaw",
  );
  const approvedBudgetEurmRaw = optionalNonNegative(
    budget.approvedBudgetEurmRaw,
    "budget.approvedBudgetEurmRaw",
  );

  if (approvedBudgetEurmRaw === null) {
    blockers.push(
      issue("APPROVED_BUDGET_MISSING", "The exact numeric B is absent."),
    );
  } else if (
    !hasText(budget.approvedBy) ||
    !hasText(budget.approvalReference)
  ) {
    blockers.push(
      issue(
        "BUDGET_APPROVAL_EVIDENCE_MISSING",
        "The recorded B lacks its accountable approver or approval reference.",
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
  };
}

function inspectSafe(snapshot, blockers) {
  const controls = requiredObject(snapshot.controls, "snapshot.controls");
  const safe = requiredObject(controls.safe, "controls.safe");
  const address = safe.address;
  const threshold = positive(safe.threshold, "controls.safe.threshold");
  const ownerCount = positive(safe.ownerCount, "controls.safe.ownerCount");
  const nonce = nonNegative(safe.nonce, "controls.safe.nonce");
  const validAddress = hasText(address) && ADDRESS_PATTERN.test(address);
  const ownerSetVerifiedAtPin = safe.ownerSetVerifiedAtPin === true;
  const structurallyValid =
    validAddress && threshold <= ownerCount && ownerSetVerifiedAtPin;
  const matchesExpectedControlStructure =
    validAddress &&
    address.toLowerCase() === EXPECTED_SAFE_ADDRESS &&
    threshold === EXPECTED_SAFE_THRESHOLD &&
    ownerCount === EXPECTED_SAFE_OWNER_COUNT;

  if (!validAddress || threshold > ownerCount) {
    blockers.push(
      issue(
        "SAFE_STRUCTURE_INVALID",
        "The Safe address, threshold, or owner count is structurally invalid.",
      ),
    );
  }
  if (!ownerSetVerifiedAtPin) {
    blockers.push(
      issue(
        "SAFE_OWNER_SET_UNVERIFIED",
        "The snapshot does not record a same-pin Safe owner-set read.",
      ),
    );
  }
  if (!matchesExpectedControlStructure) {
    blockers.push(
      issue(
        "SAFE_EXPECTED_CONFIGURATION_MISMATCH",
        "The Safe address or 4-of-6 structure does not match the expected EUROP control structure.",
      ),
    );
  }

  return {
    address,
    threshold,
    ownerCount,
    nonce,
    ownerSetVerifiedAtPin,
    structurallyValid,
    matchesExpectedControlStructure,
    authenticated: false,
  };
}

function inspectRateControl(snapshot, blockers) {
  const controls = requiredObject(snapshot.controls, "snapshot.controls");
  const rate = requiredObject(controls.rate, "controls.rate");
  const noChangeClaim = rate.enforcedNoChange === true;
  const noArbitrageClaim = rate.enforcedNoArbitrage === true;
  const maxSuccessfulTransitionsClaim = optionalNonNegative(
    rate.maxSuccessfulTransitions,
    "controls.rate.maxSuccessfulTransitions",
  );

  if (
    !noChangeClaim &&
    !noArbitrageClaim &&
    maxSuccessfulTransitionsClaim === null
  ) {
    blockers.push(
      issue(
        "RATE_TRANSITION_BOUND_MISSING",
        "Bidirectional manual-rate trading has no recorded no-change, no-arbitrage, or maximum-transition control for S.",
      ),
    );
  }

  return {
    noChangeClaim,
    noArbitrageClaim,
    maxSuccessfulTransitionsClaim,
    authenticated: false,
  };
}

function inspectStrategies(snapshot, blockers) {
  const controls = requiredObject(snapshot.controls, "snapshot.controls");
  const strategies = requiredArray(controls.strategies, "controls.strategies");
  const enumerationClaim = controls.strategiesEnumeratedThroughBlock === true;

  if (!enumerationClaim) {
    blockers.push(
      issue(
        "STRATEGY_ENUMERATION_UNVERIFIED",
        "The snapshot does not record every strategy enabled through the pinned block.",
      ),
    );
  }

  const entries = strategies.map((strategy, index) => {
    const parsed = requiredObject(strategy, `controls.strategies[${index}]`);
    const name = hasText(parsed.name) ? parsed.name : `strategy-${index}`;
    const enabled = parsed.enabled === true;
    const cooldownSeconds = optionalNonNegative(
      parsed.cooldownSeconds,
      `controls.strategies[${index}].cooldownSeconds`,
    );
    const maxQuoteOutflowClaimEurmRaw = optionalNonNegative(
      parsed.maxQuoteOutflowEurmRaw,
      `controls.strategies[${index}].maxQuoteOutflowEurmRaw`,
    );
    const mintsQuoteIntoPoolClaim =
      parsed.kind === "reserve" && parsed.mintsQuoteIntoPool !== false;
    const mintCapClaimEurmRaw = mintsQuoteIntoPoolClaim
      ? optionalNonNegative(
          parsed.mintCapEurmRaw,
          `controls.strategies[${index}].mintCapEurmRaw`,
        )
      : null;

    if (enabled && maxQuoteOutflowClaimEurmRaw === null) {
      blockers.push(
        issue(
          "STRATEGY_BOUNDARY_MODEL_MISSING",
          `${name} is enabled without a recorded quote-asset boundary model for S.`,
        ),
      );
    }
    if (enabled && mintsQuoteIntoPoolClaim && mintCapClaimEurmRaw === null) {
      blockers.push(
        issue(
          "RESERVE_MINT_CAP_MISSING",
          `${name} can mint quote assets into the pool without a recorded cap for S.`,
        ),
      );
    }

    return {
      name,
      kind: parsed.kind ?? "unknown",
      enabled,
      cooldownSeconds,
      maxQuoteOutflowClaimEurmRaw,
      mintsQuoteIntoPoolClaim,
      mintCapClaimEurmRaw,
      authenticated: false,
    };
  });

  return { enumerationClaim, authenticated: false, entries };
}

function inspectCertificate(snapshot, evaluation, blockers) {
  const certificate = requiredObject(
    snapshot.certificate,
    "snapshot.certificate",
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

  return { expiries, authenticated: false };
}

function inspectBoundaryModelClaims(snapshot, blockers) {
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

/**
 * Fail-closed EUROP operational-admission diagnostic. This implementation
 * cannot grant readiness or Live admission. It always reports Blocked until an
 * executable authenticated sequential loss model replaces the static claims.
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
