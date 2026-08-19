#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ENVIO_ORG = "mento-protocol";
const ENVIO_INDEXER = "mento";

function usage() {
  return `Usage: pnpm deploy:indexer:perf [<commit>] [--json] [--since <window>] [--build-since <window>]

Read-only hosted performance snapshot for ${ENVIO_ORG}/${ENVIO_INDEXER}.

Examples:
  pnpm deploy:indexer:perf 73fbb2e
  pnpm deploy:indexer:perf 73fbb2e --json
  pnpm deploy:indexer:perf 73fbb2e --since 2h --build-since 24h`;
}

function parseArgs(argv) {
  const parsed = {
    target: "",
    json: false,
    runtimeSince: "2h",
    buildSince: "24h",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json" || arg === "-j") {
      parsed.json = true;
      continue;
    }
    if (arg === "--since") {
      const value = argv[index + 1];
      if (!value) throw new Error("--since requires a value");
      parsed.runtimeSince = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      parsed.runtimeSince = arg.slice("--since=".length);
      continue;
    }
    if (arg === "--build-since") {
      const value = argv[index + 1];
      if (!value) throw new Error("--build-since requires a value");
      parsed.buildSince = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--build-since=")) {
      parsed.buildSince = arg.slice("--build-since=".length);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unexpected flag: ${arg}`);
    if (parsed.target) throw new Error(`Unexpected argument: ${arg}`);
    parsed.target = arg;
  }
  return parsed;
}

function runEnvioCloud(args, { optional = false } = {}) {
  const result = spawnSync("pnpm", ["exec", "envio-cloud", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (optional) return { ok: false, output: "", error: result.error.message };
    throw result.error;
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    if (optional) return { ok: false, output: result.stdout, error: message };
    throw new Error(message || `envio-cloud exited ${result.status}`);
  }
  return { ok: true, output: result.stdout.trim(), error: "" };
}

function readJson(args) {
  const result = runEnvioCloud([...args, "-o", "json"]);
  return JSON.parse(result.output);
}

export function resolveDeployment(deployments, target) {
  const sortedDeployments = [...deployments].sort((a, b) =>
    String(b.created_time ?? "").localeCompare(String(a.created_time ?? "")),
  );
  if (!target) {
    return (
      sortedDeployments.find((deployment) => Boolean(deployment.commit_hash)) ??
      null
    );
  }

  const matches = sortedDeployments.filter((deployment) => {
    const commit = String(deployment.commit_hash ?? "");
    if (!commit) return false;
    return commit.startsWith(target) || target.startsWith(commit);
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

function progress(row) {
  const start = Number(row.start_block ?? 0);
  const head = Number(row.block_height ?? 0);
  const processed = Number(row.latest_processed_block ?? -1);
  const denominator = Math.max(head - start, 1);
  const numerator = Math.max(Math.min(processed, head) - start, 0);
  return { numerator, denominator, percent: (numerator / denominator) * 100 };
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function formatPct(value) {
  return `${value.toFixed(1)}%`;
}

function summarizeStatus(rows) {
  const parts = rows.map(progress);
  const denominator = Math.max(
    parts.reduce((sum, part) => sum + part.denominator, 0),
    1,
  );
  const numerator = parts.reduce((sum, part) => sum + part.numerator, 0);
  const allCaughtUp =
    rows.length > 0 &&
    rows.every((row) => Boolean(row.timestamp_caught_up_to_head_or_endblock));
  return {
    allCaughtUp,
    overallPercent: (numerator / denominator) * 100,
    rows: rows.map((row, index) => ({
      chainId: row.chain_id,
      percent: parts[index]?.percent ?? 0,
      startBlock: row.start_block,
      headBlock: row.block_height,
      processedBlock: row.latest_processed_block,
      fetchedBlock: row.latest_fetched_block_number,
      eventsProcessed: row.num_events_processed,
      caughtUpAt: row.timestamp_caught_up_to_head_or_endblock || "",
    })),
  };
}

function interestingLines(logText, limit = 12) {
  return logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes("Build succeeded") ||
        line.includes("Build failed") ||
        line.includes("WARN") ||
        line.includes("ERROR"),
    )
    .slice(-limit);
}

function countLogLevels(logText) {
  return {
    warn: (logText.match(/\bWARN\b/g) ?? []).length,
    error: (logText.match(/\bERROR\b/g) ?? []).length,
  };
}

function logSnapshot(commit, args) {
  const build = runEnvioCloud(
    [
      "deployment",
      "logs",
      ENVIO_INDEXER,
      commit,
      ENVIO_ORG,
      "--build",
      "--since",
      args.buildSince,
    ],
    { optional: true },
  );
  const runtime = runEnvioCloud(
    [
      "deployment",
      "logs",
      ENVIO_INDEXER,
      commit,
      ENVIO_ORG,
      "--level",
      "error,warn",
      "--since",
      args.runtimeSince,
    ],
    { optional: true },
  );
  return {
    build: {
      ok: build.ok,
      error: build.error,
      interesting: build.ok ? interestingLines(build.output) : [],
    },
    runtime: {
      ok: runtime.ok,
      error: runtime.error,
      counts: runtime.ok
        ? countLogLevels(runtime.output)
        : { warn: 0, error: 0 },
      interesting: runtime.ok ? interestingLines(runtime.output) : [],
    },
  };
}

function printHuman(report) {
  const summary = report.statusSummary;
  console.log(`Deployment perf snapshot: ${ENVIO_ORG}/${ENVIO_INDEXER}`);
  console.log(`Commit: ${report.commit}`);
  console.log(`Created: ${report.deployment.created_time ?? "unknown"}`);
  console.log(`Prod status: ${report.deployment.prod_status ?? "unknown"}`);
  console.log(
    `Sync: ${summary.allCaughtUp ? "caught_up" : "syncing"} overall=${formatPct(
      summary.overallPercent,
    )}`,
  );
  console.log("");
  console.log(
    "CHAIN  CATCH-UP  START       HEAD        PROCESSED   EVENTS     CAUGHT UP AT",
  );
  for (const row of summary.rows) {
    console.log(
      [
        String(row.chainId).padEnd(5),
        formatPct(row.percent).padEnd(8),
        formatNumber(row.startBlock).padEnd(10),
        formatNumber(row.headBlock).padEnd(11),
        formatNumber(row.processedBlock).padEnd(11),
        formatNumber(row.eventsProcessed).padEnd(9),
        row.caughtUpAt || "-",
      ].join("  "),
    );
  }
  console.log("");
  if (report.logs.build.ok) {
    console.log("Build log highlights:");
    for (const line of report.logs.build.interesting) console.log(`  ${line}`);
    if (report.logs.build.interesting.length === 0) console.log("  none");
  } else {
    console.log(`Build logs unavailable: ${report.logs.build.error}`);
  }
  console.log("");
  if (report.logs.runtime.ok) {
    const { warn, error } = report.logs.runtime.counts;
    console.log(
      `Runtime warn/error lines in ${report.args.runtimeSince}: warn=${warn} error=${error}`,
    );
    for (const line of report.logs.runtime.interesting)
      console.log(`  ${line}`);
    if (report.logs.runtime.interesting.length === 0) console.log("  none");
  } else {
    console.log(`Runtime logs unavailable: ${report.logs.runtime.error}`);
  }
  console.log("");
  console.log(
    `Next status watch: pnpm deploy:indexer:status ${report.commit} --watch --compact`,
  );
  console.log(
    `Pre-promote verifier: pnpm deploy:indexer:verify ${report.commit}`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson(["indexer", "get", ENVIO_INDEXER, ENVIO_ORG]);
  const deployments = registry.data?.deployments ?? [];
  const deployment = resolveDeployment(deployments, args.target);
  if (!deployment) {
    throw new Error(
      `Deployment ${args.target || "(latest)"} not found for ${ENVIO_ORG}/${ENVIO_INDEXER}`,
    );
  }
  const commit = deployment.commit_hash;
  const status = readJson([
    "deployment",
    "status",
    ENVIO_INDEXER,
    commit,
    ENVIO_ORG,
  ]);
  const metrics = readJson([
    "deployment",
    "metrics",
    ENVIO_INDEXER,
    commit,
    ENVIO_ORG,
  ]);
  const report = {
    args,
    commit,
    deployment,
    status: status.data ?? [],
    metrics: metrics.data ?? [],
    statusSummary: summarizeStatus(status.data ?? []),
    logs: logSnapshot(commit, args),
  };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`deploy:indexer:perf failed: ${error.message}`);
    console.error(usage());
    process.exit(1);
  }
}
