import { Kind, parse } from "graphql";
import { summarizePolygonPools } from "../lib/polygon-deployment-semantics.mjs";
import {
  DEPLOYMENT_IDENTITY_PROBE,
  parseSafeInteger,
  summarizeDeploymentIdentity,
  summarizeStatus,
} from "./deploy-indexer-verify-status-identity.mjs";

export { summarizeDeploymentIdentity, summarizeStatus };

const ENVIO_ORG = "mento-protocol";
const ENVIO_INDEXER = "mento";
const INDEXER_SCHEMA_PATH = "indexer-envio/schema.graphql";
const SUSDS_EVENTS_PATH = "indexer-envio/src/handlers/susdsEvents.ts";
const REPLAY_INTEGRITY_PATH = "indexer-envio/config/replay-integrity.json";
const REQUIRED_POLYGON_ORACLE_FRESHNESS_VERSION = 3;
const SUSDS_LAUNCH_BASELINE_ID = "1-susds-launch";
const SUSDS_SAMPLER_PROGRESS_ID = "1-susds-sampler";
const SUSDS_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const SUSDS_LAUNCH_BLOCK = 24_573_203;
const SUSDS_LAUNCH_TIMESTAMP = 1_772_496_000;
const SUSDS_MAX_SAMPLE_BLOCK_LAG = 600;
const SUSDS_MAX_SAMPLE_AGE_SECONDS = 24 * 60 * 60;

const CORE_PROBE_TABLES = [
  "Pool",
  "SusdsYieldSummary",
  "SusdsYieldMovement",
  "StethYieldSummary",
  "StethYieldMovement",
];

const SUSDS_LAUNCH_BASELINE_PROBE = `  SusdsYieldLaunchBaseline(
    limit: 1
    where: { id: { _eq: "1-susds-launch" } }
  ) { id chainId token launchBlock launchTimestamp sharePriceUsdWei sampledAtBlock sampledAtTimestamp }
`;

const SUSDS_DAILY_SNAPSHOT_PROBE =
  "  SusdsYieldDailySnapshot(limit: 1, order_by: { sampledAtBlock: desc }) { id timestamp totalEarnedYieldUsdWei sampledAtBlock sampledAtTimestamp }\n";

const SUSDS_SAMPLER_PROGRESS_PROBE = `  SusdsYieldSamplerProgress(
    limit: 1
    where: { id: { _eq: "${SUSDS_SAMPLER_PROGRESS_ID}" } }
  ) { id sampledAtBlock sampledAtTimestamp }
`;

export function buildProbeQuery({
  includeSusdsSampler = true,
  includeSusdsSamplerProgress = includeSusdsSampler,
  includeDeploymentIdentity = false,
} = {}) {
  const susdsSamplerProbe = includeSusdsSampler
    ? `${SUSDS_LAUNCH_BASELINE_PROBE}${SUSDS_DAILY_SNAPSHOT_PROBE}`
    : "";
  const susdsSamplerProgressProbe = includeSusdsSamplerProgress
    ? SUSDS_SAMPLER_PROGRESS_PROBE
    : "";
  const deploymentIdentityProbe = includeDeploymentIdentity
    ? DEPLOYMENT_IDENTITY_PROBE
    : "";

  return `query VerifyIndexerRows {
${deploymentIdentityProbe}  Pool(limit: 1) { id chainId source }
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
${susdsSamplerProbe}${susdsSamplerProgressProbe}  StethYieldSummary(limit: 1) { id lastMovementTxHash lastUpdatedBlock }
  StethYieldMovement(limit: 1, order_by: { blockNumber: asc }) { id kind txHash blockNumber }
}`;
}

export const PROBE_QUERY = buildProbeQuery();

export function summarizeSusdsLaunchBaselineSchema(
  input,
  { legacyHandlerInput } = {},
) {
  const failures = [];
  if (input?.readError) failures.push(input.readError);

  let detected = null;
  let samplerProgressDetected = null;
  if (!input?.readError) {
    if (typeof input?.value !== "string" || input.value.trim() === "") {
      failures.push(
        `could not inspect ${INDEXER_SCHEMA_PATH} for the deployment commit`,
      );
    } else {
      try {
        const document = parse(input.value);
        const objectTypes = document.definitions.filter(
          (definition) => definition.kind === Kind.OBJECT_TYPE_DEFINITION,
        );
        if (objectTypes.length === 0) {
          failures.push(
            `could not inspect ${INDEXER_SCHEMA_PATH} for the deployment commit`,
          );
        } else {
          const objectTypeNames = new Set(
            objectTypes.map((definition) => definition.name.value),
          );
          detected = objectTypeNames.has("SusdsYieldLaunchBaseline");
          samplerProgressDetected = objectTypeNames.has(
            "SusdsYieldSamplerProgress",
          );
        }
      } catch (error) {
        failures.push(
          `${INDEXER_SCHEMA_PATH} is invalid GraphQL SDL at the deployment commit: ${error.message}`,
        );
      }
    }
  }

  if (detected === true && samplerProgressDetected === false) {
    if (legacyHandlerInput?.readError) {
      failures.push(legacyHandlerInput.readError);
    } else if (
      typeof legacyHandlerInput?.value !== "string" ||
      legacyHandlerInput.value.trim() === ""
    ) {
      failures.push(
        `could not inspect ${SUSDS_EVENTS_PATH} for legacy sampler safety`,
      );
    } else if (
      /\brecordSusdsYield(?:Event)?DailySnapshot\b/.test(
        legacyHandlerInput.value,
      )
    ) {
      failures.push(
        `legacy ${SUSDS_EVENTS_PATH} writes event-time daily snapshots without SusdsYieldSamplerProgress`,
      );
    }
  }
  if (detected === false && samplerProgressDetected === true) {
    failures.push(
      "SusdsYieldSamplerProgress exists without SusdsYieldLaunchBaseline in the deployment schema",
    );
  }

  return {
    ok: failures.length === 0,
    schemaPath: INDEXER_SCHEMA_PATH,
    detected,
    required: detected !== false,
    samplerProgressDetected,
    samplerProgressRequired: samplerProgressDetected !== false,
    failures,
  };
}

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

function metricSummary(metricsJson) {
  const data = metricsJson.data;
  return {
    topLevelKeys: Object.keys(metricsJson).sort(),
    dataKind: Array.isArray(data) ? "array" : typeof data,
    dataRows: Array.isArray(data) ? data.length : undefined,
  };
}

export function summarizeProbe(
  graphqlJson,
  {
    includeSusdsSampler = true,
    includeSusdsSamplerProgress = includeSusdsSampler,
  } = {},
) {
  const errors = graphqlJson.errors ?? [];
  const probeTables = includeSusdsSampler
    ? [...CORE_PROBE_TABLES, "SusdsYieldDailySnapshot"]
    : [...CORE_PROBE_TABLES];
  if (includeSusdsSamplerProgress) {
    probeTables.push("SusdsYieldSamplerProgress");
  }
  const rowCounts = Object.fromEntries(
    probeTables.map((table) => [
      table,
      Array.isArray(graphqlJson.data?.[table])
        ? graphqlJson.data[table].length
        : 0,
    ]),
  );
  const missingTables = probeTables.filter((table) => rowCounts[table] === 0);
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
  if (
    includeSusdsSampler &&
    susdsSummaryNonzero &&
    rowCounts.SusdsYieldDailySnapshot === 0
  ) {
    if (!missingTables.includes("SusdsYieldDailySnapshot")) {
      missingTables.push("SusdsYieldDailySnapshot");
    }
  } else if (includeSusdsSampler && !susdsSummaryNonzero) {
    const index = missingTables.indexOf("SusdsYieldDailySnapshot");
    if (index !== -1) missingTables.splice(index, 1);
  }
  if (includeSusdsSamplerProgress && !susdsSummaryNonzero) {
    const index = missingTables.indexOf("SusdsYieldSamplerProgress");
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

function hasPositiveBigInteger(value) {
  if (typeof value === "bigint") return value > 0n;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export function summarizeSusdsLaunchBaseline(
  baseline,
  { required = true } = {},
) {
  const failures = [];
  if (required && baseline === undefined) {
    failures.push(
      `sUSDS sampler launch baseline row ${SUSDS_LAUNCH_BASELINE_ID} is missing`,
    );
  }

  const id = typeof baseline?.id === "string" ? baseline.id : null;
  const chainId = parseSafeInteger(baseline?.chainId);
  const token = typeof baseline?.token === "string" ? baseline.token : null;
  const launchBlock = parseSafeInteger(baseline?.launchBlock);
  const launchTimestamp = parseSafeInteger(baseline?.launchTimestamp);
  const sampledAtBlock = parseSafeInteger(baseline?.sampledAtBlock);
  const sampledAtTimestamp = parseSafeInteger(baseline?.sampledAtTimestamp);
  const sharePriceValid = hasPositiveBigInteger(baseline?.sharePriceUsdWei);

  if (required && baseline !== undefined) {
    const expectedFields = [
      ["id", id, SUSDS_LAUNCH_BASELINE_ID],
      ["chainId", chainId, 1],
      ["token", token, SUSDS_ADDRESS],
      ["launchBlock", launchBlock, SUSDS_LAUNCH_BLOCK],
      ["launchTimestamp", launchTimestamp, SUSDS_LAUNCH_TIMESTAMP],
      ["sampledAtBlock", sampledAtBlock, SUSDS_LAUNCH_BLOCK],
      ["sampledAtTimestamp", sampledAtTimestamp, SUSDS_LAUNCH_TIMESTAMP],
    ];
    for (const [field, actual, expected] of expectedFields) {
      if (actual !== expected) {
        failures.push(
          `sUSDS sampler launch baseline ${field} is ${actual ?? "missing"}; expected ${expected}`,
        );
      }
    }
    if (!sharePriceValid) {
      failures.push(
        "sUSDS sampler launch baseline has no positive sharePriceUsdWei",
      );
    }
  }

  return {
    ok: failures.length === 0,
    id,
    chainId,
    token,
    launchBlock,
    launchTimestamp,
    sampledAtBlock,
    sampledAtTimestamp,
    sharePriceValid,
    failures,
  };
}

export function summarizeSusdsSamplerProgress({
  required = true,
  summaryNonzero,
  latestSnapshot,
  samplerProgress,
  useSamplerProgress = false,
  ethereumChain,
  nowSeconds,
}) {
  if (!required || !summaryNonzero) {
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
  const latestSample = useSamplerProgress ? samplerProgress : latestSnapshot;
  const latestSampledAtBlock = parseSafeInteger(latestSample?.sampledAtBlock);
  const latestSampledAtTimestamp = parseSafeInteger(
    latestSample?.sampledAtTimestamp,
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

  if (latestSample === undefined) {
    failures.push(
      useSamplerProgress
        ? "sUSDS sampler heartbeat progress row is missing for the nonzero summary"
        : "sUSDS sampler has no daily snapshot row for the nonzero summary",
    );
  }
  if (ethereumChain === undefined) {
    failures.push(
      "sUSDS sampler cannot verify progress because Ethereum status is missing",
    );
  }
  if (latestSampledAtBlock === null) {
    failures.push(
      useSamplerProgress
        ? "sUSDS sampler heartbeat progress has no valid sampledAtBlock"
        : "sUSDS sampler latest daily row has no valid sampledAtBlock",
    );
  } else if (latestSampledAtBlock <= SUSDS_LAUNCH_BLOCK) {
    failures.push(
      `sUSDS sampler has no post-launch progress (latest sampledAtBlock ${latestSampledAtBlock}; launch ${SUSDS_LAUNCH_BLOCK})`,
    );
  }
  if (latestSampledAtTimestamp === null) {
    failures.push(
      useSamplerProgress
        ? "sUSDS sampler heartbeat progress has no valid sampledAtTimestamp"
        : "sUSDS sampler latest daily row has no valid sampledAtTimestamp",
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
  susdsLaunchBaselineSchema = {
    ok: true,
    schemaPath: INDEXER_SCHEMA_PATH,
    detected: true,
    required: true,
    samplerProgressDetected: true,
    samplerProgressRequired: true,
    failures: [],
  },
}) {
  const sync = summarizeStatus(statusJson);
  const deploymentIdentity = summarizeDeploymentIdentity(graphqlJson, sync, {
    required: args.prod === true,
  });
  const probe = summarizeProbe(graphqlJson, {
    includeSusdsSampler: susdsLaunchBaselineSchema.required,
    includeSusdsSamplerProgress:
      susdsLaunchBaselineSchema.samplerProgressRequired,
  });
  const susdsLaunchBaseline = summarizeSusdsLaunchBaseline(
    graphqlJson.data?.SusdsYieldLaunchBaseline?.[0],
    { required: susdsLaunchBaselineSchema.required },
  );
  const susdsSampler = summarizeSusdsSamplerProgress({
    required: susdsLaunchBaselineSchema.required,
    summaryNonzero: probe.susdsSummaryNonzero,
    latestSnapshot: graphqlJson.data?.SusdsYieldDailySnapshot?.[0],
    samplerProgress: graphqlJson.data?.SusdsYieldSamplerProgress?.[0],
    useSamplerProgress:
      susdsLaunchBaselineSchema.samplerProgressRequired === true,
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
  failures.push(...deploymentIdentity.failures);
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
  failures.push(...susdsLaunchBaselineSchema.failures);
  failures.push(...susdsLaunchBaseline.failures);
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
    deploymentIdentity,
    metrics: metricSummary(metricsJson),
    probe,
    susdsLaunchBaselineSchema,
    susdsLaunchBaseline,
    susdsSampler,
    replayIntegrity,
    polygon,
    failures,
  };
}
