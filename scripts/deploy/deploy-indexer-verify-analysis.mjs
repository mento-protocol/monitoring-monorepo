import { summarizePolygonPools } from "../lib/polygon-deployment-semantics.mjs";

const ENVIO_ORG = "mento-protocol";
const ENVIO_INDEXER = "mento";
const REPLAY_INTEGRITY_PATH = "indexer-envio/config/replay-integrity.json";
const REQUIRED_POLYGON_ORACLE_FRESHNESS_VERSION = 3;
const SUSDS_LAUNCH_BLOCK = 24_573_203;
const SUSDS_LAUNCH_TIMESTAMP = 1_772_496_000;
const SUSDS_MAX_SAMPLE_BLOCK_LAG = 600;
const SUSDS_MAX_SAMPLE_AGE_SECONDS = 24 * 60 * 60;

const PROBE_TABLES = [
  "Pool",
  "SusdsYieldSummary",
  "SusdsYieldMovement",
  "SusdsYieldDailySnapshot",
  "StethYieldSummary",
  "StethYieldMovement",
];

export const PROBE_QUERY = `query VerifyIndexerRows {
  Pool(limit: 1) { id chainId source }
  PolygonPool: Pool(
    where: { chainId: { _eq: 137 }, source: { _eq: "fpmm_factory" } }
    order_by: { id: asc }
  ) {
    id
    source
    referenceRateFeedID
    lastOracleReportAt
    oracleExpiry
    oracleOk
    medianLive
    healthStatus
    hasHealthData
    lastOracleSnapshotTimestamp
    healthTotalSeconds
    healthBinarySeconds
  }
  SusdsYieldSummary(limit: 1) { id currentShares totalEarnedYieldUsdWei lastMovementTxHash lastUpdatedBlock }
  SusdsYieldMovement(limit: 1, order_by: { blockNumber: asc }) { id kind txHash blockNumber }
  SusdsYieldDailySnapshot(limit: 1, order_by: { sampledAtBlock: desc }) { id timestamp totalEarnedYieldUsdWei sampledAtBlock sampledAtTimestamp }
  StethYieldSummary(limit: 1) { id lastMovementTxHash lastUpdatedBlock }
  StethYieldMovement(limit: 1, order_by: { blockNumber: asc }) { id kind txHash blockNumber }
}`;

export function summarizeReplayIntegrity(input) {
  const observedVersion = Number(
    input?.value?.polygonExactMedianTimestamp ?? 0,
  );
  const failures = [];
  if (input?.readError) failures.push(input.readError);
  if (
    !Number.isSafeInteger(observedVersion) ||
    observedVersion < REQUIRED_POLYGON_ORACLE_FRESHNESS_VERSION
  ) {
    failures.push(
      `deployment predates Polygon event-sourced oracle-freshness replay integrity v${REQUIRED_POLYGON_ORACLE_FRESHNESS_VERSION}`,
    );
  }
  return {
    ok: failures.length === 0,
    markerPath: REPLAY_INTEGRITY_PATH,
    requiredVersion: REQUIRED_POLYGON_ORACLE_FRESHNESS_VERSION,
    observedVersion,
    failures,
  };
}

export function summarizeStatus(statusJson) {
  const chains = (statusJson.data ?? []).map((row) => ({
    chainId: row.chain_id,
    startBlock: Number(row.start_block ?? 0),
    headBlock: Number(row.block_height ?? 0),
    processedBlock: Number(row.latest_processed_block ?? 0),
    fetchedBlock: Number(row.latest_fetched_block_number ?? 0),
    events: Number(row.num_events_processed ?? 0),
    syncedAt: row.timestamp_caught_up_to_head_or_endblock ?? "",
  }));

  return {
    allSynced: chains.length > 0 && chains.every((chain) => chain.syncedAt),
    chains,
  };
}

function metricSummary(metricsJson) {
  const data = metricsJson.data;
  return {
    topLevelKeys: Object.keys(metricsJson).sort(),
    dataKind: Array.isArray(data) ? "array" : typeof data,
    dataRows: Array.isArray(data) ? data.length : undefined,
  };
}

export function summarizeProbe(graphqlJson) {
  const errors = graphqlJson.errors ?? [];
  const rowCounts = Object.fromEntries(
    PROBE_TABLES.map((table) => [
      table,
      Array.isArray(graphqlJson.data?.[table])
        ? graphqlJson.data[table].length
        : 0,
    ]),
  );
  const missingTables = PROBE_TABLES.filter((table) => rowCounts[table] === 0);
  const susdsSummary = graphqlJson.data?.SusdsYieldSummary?.[0];
  const susdsSummaryNonzero =
    susdsSummary !== undefined &&
    [
      "currentShares",
      "totalEarnedYieldUsdWei",
      "currentValueUsdWei",
      "unrealizedYieldUsdWei",
    ].some((field) => {
      const value = susdsSummary?.[field];
      if (typeof value === "bigint") return value !== 0n;
      if (typeof value === "number")
        return Number.isFinite(value) && value !== 0;
      if (typeof value !== "string" || !/^-?\d+$/.test(value)) return false;
      try {
        return BigInt(value) !== 0n;
      } catch {
        return false;
      }
    });
  if (susdsSummaryNonzero && rowCounts.SusdsYieldDailySnapshot === 0) {
    if (!missingTables.includes("SusdsYieldDailySnapshot")) {
      missingTables.push("SusdsYieldDailySnapshot");
    }
  } else if (!susdsSummaryNonzero) {
    const index = missingTables.indexOf("SusdsYieldDailySnapshot");
    if (index !== -1) missingTables.splice(index, 1);
  }

  return {
    rowCounts,
    errors: errors.map((error) => error.message ?? String(error)),
    missingTables,
    susdsSummaryNonzero,
    ok: errors.length === 0 && missingTables.length === 0,
  };
}

function parseSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function summarizeSusdsSamplerProgress({
  summaryNonzero,
  latestSnapshot,
  ethereumChain,
  nowSeconds,
}) {
  if (!summaryNonzero) {
    return {
      ok: true,
      failures: [],
      latestSampledAtBlock: null,
      latestSampledAtTimestamp: null,
      processedBlock: ethereumChain?.processedBlock ?? null,
      blockLag: null,
      ageSeconds: null,
    };
  }

  const failures = [];
  const latestSampledAtBlock = parseSafeInteger(latestSnapshot?.sampledAtBlock);
  const latestSampledAtTimestamp = parseSafeInteger(
    latestSnapshot?.sampledAtTimestamp,
  );
  const processedBlock = parseSafeInteger(ethereumChain?.processedBlock);
  const blockLag =
    processedBlock !== null && latestSampledAtBlock !== null
      ? processedBlock - latestSampledAtBlock
      : null;
  const currentTime = parseSafeInteger(nowSeconds);
  const ageSeconds =
    currentTime !== null && latestSampledAtTimestamp !== null
      ? currentTime - latestSampledAtTimestamp
      : null;

  if (latestSnapshot === undefined) {
    failures.push(
      "sUSDS sampler has no daily snapshot row for the nonzero summary",
    );
  }
  if (ethereumChain === undefined) {
    failures.push(
      "sUSDS sampler cannot verify progress because Ethereum status is missing",
    );
  }
  if (latestSampledAtBlock === null) {
    failures.push("sUSDS sampler latest daily row has no valid sampledAtBlock");
  } else if (latestSampledAtBlock <= SUSDS_LAUNCH_BLOCK) {
    failures.push(
      `sUSDS sampler has no post-launch progress (latest sampledAtBlock ${latestSampledAtBlock}; launch ${SUSDS_LAUNCH_BLOCK})`,
    );
  }
  if (latestSampledAtTimestamp === null) {
    failures.push(
      "sUSDS sampler latest daily row has no valid sampledAtTimestamp",
    );
  } else if (latestSampledAtTimestamp <= SUSDS_LAUNCH_TIMESTAMP) {
    failures.push(
      `sUSDS sampler latest sampledAtTimestamp ${latestSampledAtTimestamp} is still the launch baseline`,
    );
  }
  if (processedBlock === null) {
    failures.push("sUSDS sampler cannot verify Ethereum processed head");
  } else if (latestSampledAtBlock !== null) {
    if (latestSampledAtBlock > processedBlock) {
      failures.push(
        `sUSDS sampler latest sampledAtBlock ${latestSampledAtBlock} is ahead of Ethereum processed head ${processedBlock}`,
      );
    } else if (blockLag >= SUSDS_MAX_SAMPLE_BLOCK_LAG) {
      failures.push(
        `sUSDS sampler is stale at Ethereum processed head ${processedBlock}: latest sample is ${blockLag} blocks behind (maximum ${SUSDS_MAX_SAMPLE_BLOCK_LAG - 1})`,
      );
    }
  }
  if (currentTime !== null && latestSampledAtTimestamp !== null) {
    if (ageSeconds < 0) {
      failures.push(
        `sUSDS sampler latest sampledAtTimestamp ${latestSampledAtTimestamp} is in the future relative to verifier time ${currentTime}`,
      );
    } else if (ageSeconds > SUSDS_MAX_SAMPLE_AGE_SECONDS) {
      failures.push(
        `sUSDS sampler latest sample is ${ageSeconds} seconds old (maximum ${SUSDS_MAX_SAMPLE_AGE_SECONDS})`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    latestSampledAtBlock,
    latestSampledAtTimestamp,
    processedBlock,
    blockLag,
    ageSeconds,
  };
}

export function buildSummary({
  args,
  deployment,
  endpoint,
  endpointMode,
  statusJson,
  metricsJson,
  graphqlJson,
  nowSeconds,
  replayIntegrityInput,
}) {
  const sync = summarizeStatus(statusJson);
  const probe = summarizeProbe(graphqlJson);
  const susdsSampler = summarizeSusdsSamplerProgress({
    summaryNonzero: probe.susdsSummaryNonzero,
    latestSnapshot: graphqlJson.data?.SusdsYieldDailySnapshot?.[0],
    ethereumChain: sync.chains.find((chain) => Number(chain.chainId) === 1),
    nowSeconds,
  });
  const replayIntegrity = summarizeReplayIntegrity(replayIntegrityInput);
  const polygon = summarizePolygonPools(
    graphqlJson.data?.PolygonPool,
    nowSeconds,
  );
  const failures = [];

  if (!args.allowSyncing && !sync.allSynced) {
    failures.push("deployment is not caught up on every chain");
  }
  if (!probe.ok) {
    if (probe.errors.length > 0) {
      failures.push(
        `GraphQL probe returned errors: ${probe.errors.join("; ")}`,
      );
    }
    if (probe.missingTables.length > 0) {
      failures.push(
        `GraphQL probe returned no rows for: ${probe.missingTables.join(", ")}`,
      );
    }
  }
  failures.push(...susdsSampler.failures);
  failures.push(...replayIntegrity.failures);
  failures.push(...polygon.failures);

  return {
    ok: failures.length === 0,
    org: ENVIO_ORG,
    indexer: ENVIO_INDEXER,
    commit: deployment.commit_hash,
    prodStatus: deployment.prod_status ?? "",
    createdTime: deployment.created_time ?? "",
    endpoint,
    endpointMode,
    sync,
    metrics: metricSummary(metricsJson),
    probe,
    susdsSampler,
    replayIntegrity,
    polygon,
    failures,
  };
}
