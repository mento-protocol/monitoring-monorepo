#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { summarizePolygonPools } from "./lib/polygon-deployment-semantics.mjs";

const ENVIO_ORG = "mento-protocol";
const ENVIO_INDEXER = "mento";
const GRAPHQL_TIMEOUT_MS = 20_000;
const REPLAY_INTEGRITY_PATH = "indexer-envio/config/replay-integrity.json";
const REQUIRED_POLYGON_EXACT_MEDIAN_VERSION = 1;

const PROBE_TABLES = [
  "Pool",
  "SusdsYieldSummary",
  "SusdsYieldMovement",
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
  SusdsYieldSummary(limit: 1) { id lastMovementTxHash lastUpdatedBlock }
  SusdsYieldMovement(limit: 1, order_by: { blockNumber: asc }) { id kind txHash blockNumber }
  StethYieldSummary(limit: 1) { id lastMovementTxHash lastUpdatedBlock }
  StethYieldMovement(limit: 1, order_by: { blockNumber: asc }) { id kind txHash blockNumber }
}`;

export function parseArgs(argv) {
  const args = {
    target: "",
    json: false,
    prod: false,
    allowSyncing: false,
    help: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case "--json":
      case "-j":
        args.json = true;
        break;
      case "--prod":
        args.prod = true;
        break;
      case "--allow-syncing":
        args.allowSyncing = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        if (args.target) {
          throw new Error(`Unexpected extra deployment argument: ${arg}`);
        }
        args.target = arg;
    }
  }

  return args;
}

export function extractJsonValue(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return "";

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const opener = stack.pop();
      if (
        (char === "}" && opener !== "{") ||
        (char === "]" && opener !== "[")
      ) {
        throw new Error("Malformed JSON output");
      }
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error("Unterminated JSON output");
}

export function parseJsonOutput(text, label) {
  const candidates = [...text.matchAll(/[[{]/g)].map((match) => match.index);
  let lastError;

  for (const start of candidates) {
    try {
      return JSON.parse(extractJsonValue(text.slice(start)));
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw new Error(
      `${label} did not contain parseable JSON: ${lastError.message}`,
    );
  }
  throw new Error(`${label} did not contain JSON output`);
}

function runCommand(command, args, { json = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\n${output}`,
    );
  }

  return json
    ? parseJsonOutput(result.stdout, `${command} ${args.join(" ")}`)
    : result.stdout.trim();
}

function runEnvioJson(args) {
  return runCommand(
    "pnpm",
    ["--silent", "exec", "envio-cloud", ...args, "-o", "json"],
    { json: true },
  );
}

function runEnvioText(args) {
  return runCommand("pnpm", ["--silent", "exec", "envio-cloud", ...args]);
}

function verifyGitTarget(target) {
  if (!target) return "";

  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${target}^{commit}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );

  return result.status === 0 ? result.stdout.trim() : "";
}

function replayIntegrityFromCommit(commit) {
  const result = spawnSync(
    "git",
    ["show", `${commit}:${REPLAY_INTEGRITY_PATH}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) {
    return {
      value: null,
      readError: `could not read ${REPLAY_INTEGRITY_PATH} from deployment commit ${commit}`,
    };
  }
  try {
    return { value: JSON.parse(result.stdout), readError: "" };
  } catch (error) {
    return {
      value: null,
      readError: `${REPLAY_INTEGRITY_PATH} is invalid JSON at deployment commit ${commit}: ${error.message}`,
    };
  }
}

export function summarizeReplayIntegrity(input) {
  const observedVersion = Number(
    input?.value?.polygonExactMedianTimestamp ?? 0,
  );
  const failures = [];
  if (input?.readError) failures.push(input.readError);
  if (
    !Number.isSafeInteger(observedVersion) ||
    observedVersion < REQUIRED_POLYGON_EXACT_MEDIAN_VERSION
  ) {
    failures.push(
      `deployment predates Polygon exact-median replay integrity v${REQUIRED_POLYGON_EXACT_MEDIAN_VERSION}`,
    );
  }
  return {
    ok: failures.length === 0,
    markerPath: REPLAY_INTEGRITY_PATH,
    requiredVersion: REQUIRED_POLYGON_EXACT_MEDIAN_VERSION,
    observedVersion,
    failures,
  };
}

function deploymentsFromIndexer(indexerJson) {
  return [...(indexerJson.data?.deployments ?? [])].sort((a, b) =>
    String(b.created_time ?? "").localeCompare(String(a.created_time ?? "")),
  );
}

export function resolveDeployment(indexerJson, target, verifiedTarget = "") {
  const deployments = deploymentsFromIndexer(indexerJson);

  if (!target) {
    return deployments[0] ?? null;
  }

  const matches = deployments.filter((deployment) => {
    const commit = String(deployment.commit_hash ?? "");
    if (!commit) return false;
    return (
      commit.startsWith(target) ||
      (verifiedTarget && verifiedTarget.startsWith(commit))
    );
  });

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous deployment commit ${target} matches: ${matches
        .map((deployment) => deployment.commit_hash)
        .join(", ")}`,
    );
  }

  return matches[0] ?? null;
}

export function resolveProdDeployment(indexerJson) {
  return deploymentsFromIndexer(indexerJson).find(
    (deployment) => deployment.prod_status === "prod",
  );
}

function extractUrl(text) {
  return text.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, "") ?? "";
}

function endpointFromDeployment(deployment) {
  return String(deployment?.gql_endpoint ?? deployment?.endpoint ?? "");
}

function resolveDeploymentEndpoint(deployment) {
  const endpoint = endpointFromDeployment(deployment);
  if (endpoint) return endpoint;

  const output = runEnvioText([
    "deployment",
    "endpoint",
    ENVIO_INDEXER,
    deployment.commit_hash,
    ENVIO_ORG,
  ]);
  const extracted = extractUrl(output);
  if (!extracted) {
    throw new Error(
      `Could not resolve GraphQL endpoint for ${deployment.commit_hash}`,
    );
  }
  return extracted;
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

  return {
    rowCounts,
    errors: errors.map((error) => error.message ?? String(error)),
    missingTables,
    ok: errors.length === 0 && missingTables.length === 0,
  };
}

async function queryGraphql(endpoint) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: PROBE_QUERY }),
    signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GraphQL probe returned HTTP ${response.status}: ${body}`);
  }

  return parseJsonOutput(body, "GraphQL probe");
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
    replayIntegrity,
    polygon,
    failures,
  };
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

export function renderText(summary) {
  const lines = [
    `Indexer verification: ${summary.org}/${summary.indexer}`,
    `Deployment: ${summary.commit}${summary.prodStatus ? ` (${summary.prodStatus})` : ""}`,
    `Endpoint: ${summary.endpoint} [${summary.endpointMode}]`,
    "",
    "Sync:",
  ];

  for (const chain of summary.sync.chains) {
    lines.push(
      `  chain ${chain.chainId}: processed ${formatNumber(
        chain.processedBlock,
      )}/${formatNumber(chain.headBlock)}; events ${formatNumber(
        chain.events,
      )}; syncedAt ${chain.syncedAt || "-"}`,
    );
  }
  lines.push(
    `  all chains caught up: ${summary.sync.allSynced ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push(
    `Metrics: fetched (${summary.metrics.dataKind}${
      summary.metrics.dataRows === undefined
        ? ""
        : `, ${summary.metrics.dataRows} row(s)`
    })`,
  );
  lines.push("");
  lines.push("GraphQL row probe:");
  for (const [table, count] of Object.entries(summary.probe.rowCounts)) {
    lines.push(`  ${table}: ${count}`);
  }
  lines.push("");
  lines.push("Replay integrity contract:");
  lines.push(
    `  Polygon exact median: v${summary.replayIntegrity.observedVersion}/v${summary.replayIntegrity.requiredVersion}`,
  );
  lines.push("");
  lines.push("Polygon replay semantics:");
  lines.push(
    `  FPMMs: ${summary.polygon.actualCount}/${summary.polygon.expectedCount}`,
  );
  lines.push(`  semantic integrity: ${summary.polygon.ok ? "yes" : "no"}`);

  if (summary.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const failure of summary.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  lines.push(`Result: ${summary.ok ? "verified" : "failed"}`);
  return lines.join("\n");
}

function printUsage() {
  console.log(`Usage:
  pnpm deploy:indexer:verify [<commit>] [--json]
  pnpm deploy:indexer:verify <commit> --prod [--json]

Checks a registered Envio deployment by fetching status, metrics, a GraphQL
endpoint, core rows, and fail-closed Polygon replay semantics.

Options:
  --prod           Probe the static production endpoint and require <commit> to be prod.
  --allow-syncing  Do not fail solely because one or more chains are still syncing.
                   Empty rows and Polygon semantic failures remain failures.
  --json, -j       Print machine-readable summary JSON.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const indexerJson = runEnvioJson([
    "indexer",
    "get",
    ENVIO_INDEXER,
    ENVIO_ORG,
  ]);
  const verifiedTarget = verifyGitTarget(args.target);
  let deployment = resolveDeployment(indexerJson, args.target, verifiedTarget);

  if (!deployment) {
    throw new Error(
      `Deployment ${args.target || "(latest)"} not found for ${ENVIO_ORG}/${ENVIO_INDEXER}. Wait for registration with: pnpm deploy:indexer:status ${args.target} --watch --compact`,
    );
  }

  let endpointMode =
    deployment.prod_status === "prod" ? "prod-static" : "deployment";
  if (args.prod) {
    const prodDeployment = resolveProdDeployment(indexerJson);
    if (!prodDeployment) {
      throw new Error(
        `No production deployment found for ${ENVIO_ORG}/${ENVIO_INDEXER}`,
      );
    }
    if (args.target && prodDeployment.commit_hash !== deployment.commit_hash) {
      throw new Error(
        `Deployment ${deployment.commit_hash} is not prod; current prod is ${prodDeployment.commit_hash}`,
      );
    }
    deployment = prodDeployment;
    endpointMode = "prod-static";
  }

  const endpoint = resolveDeploymentEndpoint(deployment);
  const statusJson = runEnvioJson([
    "deployment",
    "status",
    ENVIO_INDEXER,
    deployment.commit_hash,
    ENVIO_ORG,
  ]);
  const metricsJson = runEnvioJson([
    "deployment",
    "metrics",
    ENVIO_INDEXER,
    deployment.commit_hash,
    ENVIO_ORG,
  ]);
  const replayIntegrityInput = replayIntegrityFromCommit(
    deployment.commit_hash,
  );
  const graphqlJson = await queryGraphql(endpoint);
  const summary = buildSummary({
    args,
    deployment,
    endpoint,
    endpointMode,
    statusJson,
    metricsJson,
    graphqlJson,
    replayIntegrityInput,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderText(summary));
  }

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`deploy:indexer:verify failed: ${error.message}`);
    process.exitCode = 1;
  });
}
