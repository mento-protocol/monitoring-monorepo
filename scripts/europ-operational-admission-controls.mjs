import {
  EXPECTED_BREAKER_BOX,
  EXPECTED_HALT_RATE_RAW,
  EXPECTED_LP_CUSTODY_BALANCE_RAW,
  EXPECTED_LP_CUSTODY_SAFE,
  EXPECTED_LP_TOTAL_SUPPLY_RAW,
  EXPECTED_OPEN_STRATEGY,
  EXPECTED_ORACLE_ADAPTER,
  EXPECTED_PROTOCOL_FEE_RECIPIENT,
  EXPECTED_RATE_DECIMALS,
  EXPECTED_RATE_FEED,
  EXPECTED_RATE_RAW,
  EXPECTED_RESERVE_STRATEGY,
  EXPECTED_RESERVE_V2,
  EXPECTED_SAFE_ADDRESS,
  EXPECTED_SAFE_OWNER_COUNT,
  EXPECTED_SAFE_THRESHOLD,
  EXPECTED_SORTED_ORACLES,
  EXPECTED_VALUE_DELTA_BREAKER,
  EXPECTED_VALUE_DELTA_BPS,
  EXPECTED_VALUE_DELTA_THRESHOLD_RAW,
  EXPECTED_PIN_BLOCK_HASH,
  EXPECTED_PIN_BLOCK_NUMBER,
  ZERO_ADDRESS,
  hasText,
  issue,
  matchesAddress,
  nonNegative,
  optionalNonNegative,
  positive,
  requiredArray,
  requiredObject,
} from "./europ-operational-admission-contract.mjs";

export function inspectSafe(snapshot, blockers) {
  const controls = requiredObject(snapshot.controls, "snapshot.controls");
  const safe = requiredObject(controls.safe, "controls.safe");
  const address = safe.address;
  const threshold = positive(safe.threshold, "controls.safe.threshold");
  const ownerCount = positive(safe.ownerCount, "controls.safe.ownerCount");
  const nonce = nonNegative(safe.nonce, "controls.safe.nonce");
  const validAddress = hasText(address) && /^0x[0-9a-fA-F]{40}$/u.test(address);
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

export function inspectRateControl(snapshot, blockers) {
  const controls = requiredObject(snapshot.controls, "snapshot.controls");
  const rate = requiredObject(controls.rate, "controls.rate");
  const rateDecimals = nonNegative(
    rate.rateDecimals,
    "controls.rate.rateDecimals",
  );
  const manualRateRaw = positive(
    rate.manualRateRaw,
    "controls.rate.manualRateRaw",
  );
  const valueDeltaBreakerBps = nonNegative(
    rate.valueDeltaBreakerBps,
    "controls.rate.valueDeltaBreakerBps",
  );
  const valueDeltaThresholdRaw = positive(
    rate.valueDeltaThresholdRaw,
    "controls.rate.valueDeltaThresholdRaw",
  );
  const valueDeltaCooldownSeconds = nonNegative(
    rate.valueDeltaCooldownSeconds,
    "controls.rate.valueDeltaCooldownSeconds",
  );
  const currentTradingMode = nonNegative(
    rate.currentTradingMode,
    "controls.rate.currentTradingMode",
  );
  const configurationMatches =
    matchesAddress(rate.manualRateFeedId, EXPECTED_RATE_FEED) &&
    matchesAddress(rate.oracleAdapter, EXPECTED_ORACLE_ADAPTER) &&
    matchesAddress(rate.sortedOracles, EXPECTED_SORTED_ORACLES) &&
    matchesAddress(rate.breakerBox, EXPECTED_BREAKER_BOX) &&
    matchesAddress(rate.valueDeltaBreaker, EXPECTED_VALUE_DELTA_BREAKER) &&
    rateDecimals === EXPECTED_RATE_DECIMALS &&
    manualRateRaw === EXPECTED_RATE_RAW &&
    valueDeltaBreakerBps === EXPECTED_VALUE_DELTA_BPS &&
    valueDeltaThresholdRaw === EXPECTED_VALUE_DELTA_THRESHOLD_RAW &&
    valueDeltaCooldownSeconds === 1n &&
    currentTradingMode === 0n &&
    rate.valueDeltaBreakerEnabled === true;
  const noChangeClaim = rate.enforcedNoChange === true;
  const noArbitrageClaim = rate.enforcedNoArbitrage === true;
  const maxSuccessfulTransitionsClaim = optionalNonNegative(
    rate.maxSuccessfulTransitions,
    "controls.rate.maxSuccessfulTransitions",
  );

  if (!configurationMatches) {
    blockers.push(
      issue(
        "RATE_CONTROL_CONFIGURATION_MISMATCH",
        "The rate feed, adapter, breaker wiring, 50-bps threshold, reference rate, cooldown, enablement, or current trading mode differs from the approved EUROP configuration.",
      ),
    );
  }

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
    manualRateFeedId: rate.manualRateFeedId ?? null,
    oracleAdapter: rate.oracleAdapter ?? null,
    sortedOracles: rate.sortedOracles ?? null,
    breakerBox: rate.breakerBox ?? null,
    valueDeltaBreaker: rate.valueDeltaBreaker ?? null,
    rateDecimals,
    manualRateRaw,
    valueDeltaBreakerBps,
    valueDeltaThresholdRaw,
    valueDeltaCooldownSeconds,
    currentTradingMode,
    configurationMatches,
    noChangeClaim,
    noArbitrageClaim,
    maxSuccessfulTransitionsClaim,
    authenticated: false,
  };
}

export function inspectStrategies(snapshot, blockers) {
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
    const lastRebalance = optionalNonNegative(
      parsed.lastRebalance,
      `controls.strategies[${index}].lastRebalance`,
    );
    const incentives = requiredObject(
      parsed.incentives,
      `controls.strategies[${index}].incentives`,
    );
    const liquiditySourceExpansionBps = nonNegative(
      incentives.liquiditySourceExpansionBps,
      `controls.strategies[${index}].incentives.liquiditySourceExpansionBps`,
    );
    const protocolExpansionBps = nonNegative(
      incentives.protocolExpansionBps,
      `controls.strategies[${index}].incentives.protocolExpansionBps`,
    );
    const liquiditySourceContractionBps = nonNegative(
      incentives.liquiditySourceContractionBps,
      `controls.strategies[${index}].incentives.liquiditySourceContractionBps`,
    );
    const protocolContractionBps = nonNegative(
      incentives.protocolContractionBps,
      `controls.strategies[${index}].incentives.protocolContractionBps`,
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
      address: parsed.address ?? null,
      kind: parsed.kind ?? "unknown",
      enabled,
      cooldownSeconds,
      isToken0Debt: parsed.isToken0Debt === true,
      lastRebalance,
      protocolFeeRecipient: parsed.protocolFeeRecipient ?? null,
      incentives: {
        liquiditySourceExpansionBps,
        protocolExpansionBps,
        liquiditySourceContractionBps,
        protocolContractionBps,
      },
      maxQuoteOutflowClaimEurmRaw,
      mintsQuoteIntoPoolClaim,
      mintCapClaimEurmRaw,
      reserveV2: parsed.reserveV2 ?? null,
      authenticated: false,
    };
  });

  const open = entries.filter((entry) => entry.kind === "open");
  const reserve = entries.filter((entry) => entry.kind === "reserve");
  const configurationMatches =
    entries.length === 2 &&
    open.length === 1 &&
    reserve.length === 1 &&
    matchesAddress(open[0].address, EXPECTED_OPEN_STRATEGY) &&
    matchesAddress(reserve[0].address, EXPECTED_RESERVE_STRATEGY) &&
    matchesAddress(reserve[0].reserveV2, EXPECTED_RESERVE_V2) &&
    open[0].enabled &&
    reserve[0].enabled &&
    open[0].cooldownSeconds === 300n &&
    reserve[0].cooldownSeconds === 300n &&
    open[0].isToken0Debt &&
    reserve[0].isToken0Debt &&
    open[0].lastRebalance === 1_785_523_331n &&
    reserve[0].lastRebalance === 0n &&
    matchesAddress(
      open[0].protocolFeeRecipient,
      EXPECTED_PROTOCOL_FEE_RECIPIENT,
    ) &&
    matchesAddress(
      reserve[0].protocolFeeRecipient,
      EXPECTED_PROTOCOL_FEE_RECIPIENT,
    ) &&
    Object.values(open[0].incentives).every((value) => value === 0n) &&
    Object.values(reserve[0].incentives).every((value) => value === 0n);

  if (!configurationMatches) {
    blockers.push(
      issue(
        "STRATEGY_CONFIGURATION_MISMATCH",
        "The enabled Open or Reserve strategy identity, debt-token orientation, last rebalance, fee recipient, incentives, ReserveV2 source, or cooldown differs from the pinned EUROP configuration.",
      ),
    );
  }

  return {
    enumerationClaim,
    configurationMatches,
    authenticated: false,
    entries,
  };
}

export function inspectEmergencyHalt(snapshot, witnessConfiguration, blockers) {
  const halt = requiredObject(snapshot.emergencyHalt, "snapshot.emergencyHalt");
  const proof = requiredObject(
    halt.forkProof,
    "snapshot.emergencyHalt.forkProof",
  );
  const rateDecimals = nonNegative(
    halt.rateDecimals,
    "emergencyHalt.rateDecimals",
  );
  const reportRateRaw = positive(
    halt.reportRateRaw,
    "emergencyHalt.reportRateRaw",
  );
  const expectedTradingMode = nonNegative(
    halt.expectedTradingMode,
    "emergencyHalt.expectedTradingMode",
  );
  const proofBlockNumber = positive(
    proof.blockNumber,
    "emergencyHalt.forkProof.blockNumber",
  );
  const proofBlockHashMatches =
    hasText(proof.blockHash) &&
    proof.blockHash.toLowerCase() === EXPECTED_PIN_BLOCK_HASH;
  const restoredRateRaw = positive(
    proof.restoredRateRaw,
    "emergencyHalt.forkProof.restoredRateRaw",
  );
  const restoredTradingMode = nonNegative(
    proof.restoredTradingMode,
    "emergencyHalt.forkProof.restoredTradingMode",
  );
  const evidenceBlockNumber = positive(
    requiredObject(snapshot.evidence, "snapshot.evidence").blockNumber,
    "evidence.blockNumber",
  );
  const localForkClaimMatches =
    matchesAddress(halt.controlSafe, EXPECTED_SAFE_ADDRESS) &&
    matchesAddress(halt.sortedOracles, EXPECTED_SORTED_ORACLES) &&
    matchesAddress(halt.breakerBox, EXPECTED_BREAKER_BOX) &&
    matchesAddress(halt.valueDeltaBreaker, EXPECTED_VALUE_DELTA_BREAKER) &&
    matchesAddress(halt.rateFeedId, EXPECTED_RATE_FEED) &&
    matchesAddress(halt.lesserKey, ZERO_ADDRESS) &&
    matchesAddress(halt.greaterKey, ZERO_ADDRESS) &&
    rateDecimals === EXPECTED_RATE_DECIMALS &&
    reportRateRaw === EXPECTED_HALT_RATE_RAW &&
    expectedTradingMode === 1n &&
    proofBlockNumber === evidenceBlockNumber &&
    proofBlockNumber === EXPECTED_PIN_BLOCK_NUMBER &&
    proofBlockHashMatches &&
    witnessConfiguration?.datedPinMatches === true &&
    witnessConfiguration?.protocolIdentityMatches === true &&
    witnessConfiguration?.safeConfigurationMatches === true &&
    witnessConfiguration?.rateConfigurationMatches === true &&
    witnessConfiguration?.strategyConfigurationMatches === true &&
    proof.haltReportSucceeded === true &&
    proof.swapSuspended === true &&
    proof.openRebalanceSuspended === true &&
    proof.reserveRebalanceSuspended === true &&
    restoredRateRaw === EXPECTED_RATE_RAW &&
    proof.restoreReportSucceeded === true &&
    restoredTradingMode === 0n;

  if (!localForkClaimMatches) {
    blockers.push(
      issue(
        "LOCAL_FORK_HALT_CLAIM_MISMATCH",
        "The local-fork halt claim does not match the pinned diagnostic inputs or its stated halt and restore assertions.",
      ),
    );
  }

  return {
    controlSafe: halt.controlSafe ?? null,
    sortedOracles: halt.sortedOracles ?? null,
    breakerBox: halt.breakerBox ?? null,
    valueDeltaBreaker: halt.valueDeltaBreaker ?? null,
    rateFeedId: halt.rateFeedId ?? null,
    reportRateRaw,
    expectedTradingMode,
    proofBlockNumber,
    proofBlockHash: proof.blockHash ?? null,
    restoredRateRaw,
    restoredTradingMode,
    localForkClaimMatches,
    localForkClaimStatus: "unattested",
    provenance: "unattested",
    authenticated: false,
  };
}

export function inspectCustodyBoundary(snapshot, blockers) {
  const boundary = requiredObject(
    snapshot.custodyBoundary,
    "snapshot.custodyBoundary",
  );
  const safe = requiredObject(
    boundary.lpCustodySafe,
    "custodyBoundary.lpCustodySafe",
  );
  const threshold = positive(
    safe.threshold,
    "custodyBoundary.lpCustodySafe.threshold",
  );
  const ownerCount = positive(
    safe.ownerCount,
    "custodyBoundary.lpCustodySafe.ownerCount",
  );
  const nonce = nonNegative(safe.nonce, "custodyBoundary.lpCustodySafe.nonce");
  const lpBalanceRaw = nonNegative(
    safe.lpBalanceRaw,
    "custodyBoundary.lpCustodySafe.lpBalanceRaw",
  );
  const totalLpSupplyRaw = positive(
    safe.totalLpSupplyRaw,
    "custodyBoundary.lpCustodySafe.totalLpSupplyRaw",
  );
  const configurationMatches =
    matchesAddress(safe.address, EXPECTED_LP_CUSTODY_SAFE) &&
    threshold === 2n &&
    ownerCount === 4n &&
    nonce === 13n &&
    lpBalanceRaw === EXPECTED_LP_CUSTODY_BALANCE_RAW &&
    totalLpSupplyRaw === EXPECTED_LP_TOTAL_SUPPLY_RAW &&
    safe.ownerSetVerifiedAtPin === true &&
    safe.treatedAsInternalCustody === true &&
    boundary.failClosedOnUnapprovedLpExit === true &&
    boundary.failClosedOnControlDrift === true;

  if (!configurationMatches) {
    blockers.push(
      issue(
        "LP_CUSTODY_BOUNDARY_INVALID",
        "The LP custody Safe, 2-of-4 control, pinned LP balance, internal-custody treatment, or fail-closed drift policy differs from the reviewed boundary.",
      ),
    );
  }

  return {
    address: safe.address ?? null,
    threshold,
    ownerCount,
    nonce,
    lpBalanceRaw,
    totalLpSupplyRaw,
    configurationMatches,
    authenticated: false,
  };
}
