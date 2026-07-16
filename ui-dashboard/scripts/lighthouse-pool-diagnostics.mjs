#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EXPECTED_RUNS = 3;
const REPORT_PATTERN = /^lhr-.*\.json$/;
const PHASES = [
  { key: "ttfbMs", label: "TTFB" },
  { key: "loadDelayMs", label: "Load Delay" },
  { key: "loadTimeMs", label: "Load Time" },
  { key: "renderDelayMs", label: "Render Delay" },
];

function usage() {
  return [
    "Usage:",
    "  node ui-dashboard/scripts/lighthouse-pool-diagnostics.mjs \\",
    "    --dir <lighthouse-report-directory> \\",
    "    --path <exact-pathname-and-query> \\",
    "    [--expected-runs 3] \\",
    "    --output-json <diagnostics.json> \\",
    "    --output-markdown <diagnostics.md>",
  ].join("\n");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reportFinalUrl(lhr) {
  const value = lhr.finalUrl ?? lhr.finalDisplayedUrl;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("report has no finalUrl or finalDisplayedUrl");
  }
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(
      `report final URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeTargetPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error("--path must be an absolute pathname beginning with /");
  }
  try {
    const target = new URL(value, "https://lighthouse.invalid");
    return `${target.pathname}${target.search}`;
  } catch (error) {
    throw new Error(
      `--path is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseArgs(argv) {
  const parsed = { expectedRuns: DEFAULT_EXPECTED_RUNS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (
      arg !== "--dir" &&
      arg !== "--path" &&
      arg !== "--expected-runs" &&
      arg !== "--output-json" &&
      arg !== "--output-markdown"
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--expected-runs") {
      const expectedRuns = Number(value);
      if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
        throw new Error("--expected-runs must be a positive integer");
      }
      parsed.expectedRuns = expectedRuns;
    } else if (arg === "--dir") {
      parsed.dir = value;
    } else if (arg === "--path") {
      parsed.path = value;
    } else if (arg === "--output-json") {
      parsed.outputJson = value;
    } else {
      parsed.outputMarkdown = value;
    }
  }

  if (parsed.help) return parsed;
  for (const [key, flag] of [
    ["dir", "--dir"],
    ["path", "--path"],
    ["outputJson", "--output-json"],
    ["outputMarkdown", "--output-markdown"],
  ]) {
    if (!parsed[key]) throw new Error(`${flag} is required`);
  }
  if (resolve(parsed.outputJson) === resolve(parsed.outputMarkdown)) {
    throw new Error("--output-json and --output-markdown must be different");
  }
  parsed.path = normalizeTargetPath(parsed.path);
  return parsed;
}

export function readLighthouseReports(directory) {
  const absoluteDirectory = resolve(directory);
  if (!existsSync(absoluteDirectory)) {
    throw new Error(
      `Lighthouse report directory does not exist: ${absoluteDirectory}`,
    );
  }
  if (!statSync(absoluteDirectory).isDirectory()) {
    throw new Error(
      `Lighthouse report path is not a directory: ${absoluteDirectory}`,
    );
  }

  const names = readdirSync(absoluteDirectory)
    .filter((name) => REPORT_PATTERN.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error(`No lhr-*.json reports found in ${absoluteDirectory}`);
  }

  return names.map((fileName) => {
    const filePath = join(absoluteDirectory, fileName);
    let lhr;
    try {
      lhr = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Malformed Lighthouse report ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof lhr !== "object" || lhr === null || Array.isArray(lhr)) {
      throw new Error(
        `Malformed Lighthouse report ${fileName}: root must be an object`,
      );
    }
    try {
      reportFinalUrl(lhr);
    } catch (error) {
      throw new Error(
        `Malformed Lighthouse report ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { fileName, filePath, lhr };
  });
}

function emptyPhases(source = null) {
  return {
    source,
    ttfbMs: null,
    loadDelayMs: null,
    loadTimeMs: null,
    renderDelayMs: null,
  };
}

function legacyPhaseKey(phase) {
  const normalized = String(phase)
    .toLowerCase()
    .replaceAll(/[^a-z]/g, "");
  return {
    ttfb: "ttfbMs",
    loaddelay: "loadDelayMs",
    loadtime: "loadTimeMs",
    renderdelay: "renderDelayMs",
  }[normalized];
}

function insightPhaseKey(row) {
  const normalized = String(row?.phase ?? row?.label ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z]/g, "");
  return {
    timetofirstbyte: "ttfbMs",
    resourceloaddelay: "loadDelayMs",
    resourceloadduration: "loadTimeMs",
    elementrenderdelay: "renderDelayMs",
  }[normalized];
}

function phaseRows(audit) {
  const sections = audit?.details?.items;
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) =>
    Array.isArray(section?.items) ? section.items : [],
  );
}

export function extractLcpPhases(audits) {
  const legacy = emptyPhases("largest-contentful-paint-element");
  let mapped = 0;
  for (const row of phaseRows(audits?.["largest-contentful-paint-element"])) {
    const key = legacyPhaseKey(row?.phase);
    const value = finiteNumber(row?.timing);
    if (key && value !== null) {
      legacy[key] = value;
      mapped += 1;
    }
  }
  if (mapped > 0) return legacy;

  const insight = emptyPhases("lcp-phases-insight");
  mapped = 0;
  for (const row of phaseRows(audits?.["lcp-phases-insight"])) {
    const key = insightPhaseKey(row);
    const value = finiteNumber(row?.duration);
    if (key && value !== null) {
      insight[key] = value;
      mapped += 1;
    }
  }
  return mapped > 0 ? insight : emptyPhases();
}

function findLcpNode(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const node = findLcpNode(item);
      if (node) return node;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  if (
    value.type === "node" ||
    typeof value.selector === "string" ||
    typeof value.nodeLabel === "string"
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    const node = findLcpNode(child);
    if (node) return node;
  }
  return null;
}

export function extractLcpElement(audits) {
  const legacyNode = findLcpNode(
    audits?.["largest-contentful-paint-element"]?.details,
  );
  const insightNode =
    legacyNode ?? findLcpNode(audits?.["lcp-phases-insight"]?.details);
  if (!insightNode) return { selector: null, nodeLabel: null };
  return {
    selector:
      typeof insightNode.selector === "string" ? insightNode.selector : null,
    nodeLabel:
      typeof insightNode.nodeLabel === "string" ? insightNode.nodeLabel : null,
  };
}

function networkItems(audits) {
  const items = audits?.["network-requests"]?.details?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("network-requests audit has no request items");
  }
  return items;
}

function normalizedHref(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function mainDocumentRequest(lhr, finalUrl, items) {
  const preferredUrls = new Set(
    [lhr.mainDocumentUrl, finalUrl.href]
      .map(normalizedHref)
      .filter((value) => value !== null),
  );
  const documents = items.filter((item) => item?.resourceType === "Document");
  let document = null;
  for (const item of documents) {
    if (preferredUrls.has(normalizedHref(item?.url))) document = item;
  }
  if (!document) {
    throw new Error("network-requests audit has no matching main document");
  }
  const statusCode = finiteNumber(document.statusCode);
  if (statusCode === null) {
    throw new Error("main document has no numeric HTTP status");
  }
  if (statusCode < 200 || statusCode >= 400) {
    throw new Error(`main document returned HTTP ${statusCode}`);
  }
  return {
    statusCode,
    transferBytes: finiteNumber(document.transferSize),
    resourceBytes: finiteNumber(document.resourceSize),
  };
}

function isGraphqlRequest(item) {
  if (item?.resourceType === "Preflight" || item?.resourceType === "Document") {
    return false;
  }
  if (typeof item?.url !== "string") return false;
  try {
    return new URL(item.url).pathname.endsWith("/graphql");
  } catch {
    return false;
  }
}

function graphqlDiagnostics(items, lcpMs) {
  const requests = items.filter(isGraphqlRequest);
  const durations = [];
  const endTimes = [];
  for (const request of requests) {
    const start = finiteNumber(request.networkRequestTime);
    const end = finiteNumber(request.networkEndTime);
    if (end !== null) endTimes.push(end);
    if (start !== null && end !== null && end >= start) {
      durations.push(end - start);
    }
  }
  const lastEndTimeMs = endTimes.length > 0 ? Math.max(...endTimes) : null;
  let completionRelativeToLcp = "unknown";
  if (requests.length === 0) completionRelativeToLcp = "none";
  else if (lastEndTimeMs !== null) {
    completionRelativeToLcp =
      lastEndTimeMs <= lcpMs ? "before-lcp" : "after-lcp";
  }
  return {
    fetchCount: requests.length,
    medianDurationMs: median(durations),
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    lastEndTimeMs,
    completionRelativeToLcp,
  };
}

function mainThreadDiagnostics(audits) {
  const audit = audits?.["mainthread-work-breakdown"];
  const items = audit?.details?.items;
  const scriptEvaluation = Array.isArray(items)
    ? items.find(
        (item) =>
          item?.group === "scriptEvaluation" ||
          item?.groupLabel === "Script Evaluation",
      )
    : null;
  return {
    totalMs: finiteNumber(audit?.numericValue),
    scriptEvaluationMs: finiteNumber(scriptEvaluation?.duration),
  };
}

function longTaskDiagnostics(audits) {
  const items = audits?.["long-tasks"]?.details?.items;
  if (!Array.isArray(items)) return { count: null, maxDurationMs: null };
  const durations = items
    .map((item) => finiteNumber(item?.duration))
    .filter((value) => value !== null);
  return {
    count: items.length,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
  };
}

function auditNumeric(audits, id) {
  return finiteNumber(audits?.[id]?.numericValue);
}

export function extractRunDiagnostics({ fileName, lhr }) {
  const finalUrl = reportFinalUrl(lhr);
  const runtimeCode = lhr.runtimeError?.code;
  if (runtimeCode && runtimeCode !== "NO_ERROR") {
    throw new Error(
      `Lighthouse runtime error ${runtimeCode}: ${lhr.runtimeError?.message ?? "no message"}`,
    );
  }

  const audits = lhr.audits;
  if (typeof audits !== "object" || audits === null) {
    throw new Error("report has no audits object");
  }
  const lcpMs = auditNumeric(audits, "largest-contentful-paint");
  if (lcpMs === null || lcpMs <= 0) {
    throw new Error("largest-contentful-paint has no positive numericValue");
  }

  const requests = networkItems(audits);
  return {
    run: null,
    sourceFile: fileName,
    fetchTime:
      typeof lhr.fetchTime === "string" && lhr.fetchTime.length > 0
        ? lhr.fetchTime
        : null,
    finalUrl: finalUrl.href,
    lcpMs,
    lcpPhases: extractLcpPhases(audits),
    lcpElement: extractLcpElement(audits),
    document: mainDocumentRequest(lhr, finalUrl, requests),
    serverResponseTimeMs: auditNumeric(audits, "server-response-time"),
    totalBlockingTimeMs: auditNumeric(audits, "total-blocking-time"),
    mainThread: mainThreadDiagnostics(audits),
    longTasks: longTaskDiagnostics(audits),
    benchmarkIndex: finiteNumber(lhr.environment?.benchmarkIndex),
    graphql: graphqlDiagnostics(requests, lcpMs),
  };
}

export function median(values) {
  const numbers = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function medianOf(runs, getter) {
  return median(runs.map(getter));
}

function medianSummary(runs) {
  return {
    lcpMs: medianOf(runs, (run) => run.lcpMs),
    lcpPhases: {
      ttfbMs: medianOf(runs, (run) => run.lcpPhases.ttfbMs),
      loadDelayMs: medianOf(runs, (run) => run.lcpPhases.loadDelayMs),
      loadTimeMs: medianOf(runs, (run) => run.lcpPhases.loadTimeMs),
      renderDelayMs: medianOf(runs, (run) => run.lcpPhases.renderDelayMs),
    },
    document: {
      transferBytes: medianOf(runs, (run) => run.document.transferBytes),
      resourceBytes: medianOf(runs, (run) => run.document.resourceBytes),
    },
    serverResponseTimeMs: medianOf(runs, (run) => run.serverResponseTimeMs),
    totalBlockingTimeMs: medianOf(runs, (run) => run.totalBlockingTimeMs),
    mainThread: {
      totalMs: medianOf(runs, (run) => run.mainThread.totalMs),
      scriptEvaluationMs: medianOf(
        runs,
        (run) => run.mainThread.scriptEvaluationMs,
      ),
    },
    longTasks: {
      count: medianOf(runs, (run) => run.longTasks.count),
      maxDurationMs: medianOf(runs, (run) => run.longTasks.maxDurationMs),
    },
    benchmarkIndex: medianOf(runs, (run) => run.benchmarkIndex),
    graphql: {
      fetchCount: medianOf(runs, (run) => run.graphql.fetchCount),
      medianDurationMs: medianOf(runs, (run) => run.graphql.medianDurationMs),
      maxDurationMs: medianOf(runs, (run) => run.graphql.maxDurationMs),
      lastEndTimeMs: medianOf(runs, (run) => run.graphql.lastEndTimeMs),
    },
  };
}

function attributionSummary(runs, medians) {
  let dominantPhase = null;
  for (const phase of PHASES) {
    const medianMs = medians.lcpPhases[phase.key];
    if (
      medianMs !== null &&
      (dominantPhase === null || medianMs > dominantPhase.medianMs)
    ) {
      dominantPhase = { key: phase.key, label: phase.label, medianMs };
    }
  }

  const graphqlCompletion = {
    beforeLcpRuns: 0,
    afterLcpRuns: 0,
    noGraphqlRuns: 0,
    unknownRuns: 0,
  };
  for (const run of runs) {
    const relation = run.graphql.completionRelativeToLcp;
    if (relation === "before-lcp") graphqlCompletion.beforeLcpRuns += 1;
    else if (relation === "after-lcp") graphqlCompletion.afterLcpRuns += 1;
    else if (relation === "none") graphqlCompletion.noGraphqlRuns += 1;
    else graphqlCompletion.unknownRuns += 1;
  }
  return { dominantPhase, graphqlCompletion };
}

export function analyzeReports(
  reports,
  {
    targetPath,
    expectedRuns = DEFAULT_EXPECTED_RUNS,
    sourceDirectory = null,
    generatedAt = new Date().toISOString(),
  },
) {
  const normalizedPath = normalizeTargetPath(targetPath);
  if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
    throw new Error("expectedRuns must be a positive integer");
  }

  const matching = reports.filter(({ fileName, lhr }) => {
    try {
      const finalUrl = reportFinalUrl(lhr);
      return `${finalUrl.pathname}${finalUrl.search}` === normalizedPath;
    } catch (error) {
      throw new Error(
        `Malformed Lighthouse report ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  if (matching.length === 0) {
    throw new Error(
      `No Lighthouse reports matched exact path and query ${normalizedPath}`,
    );
  }
  if (matching.length !== expectedRuns) {
    throw new Error(
      `Expected exactly ${expectedRuns} Lighthouse reports for ${normalizedPath}, found ${matching.length}`,
    );
  }

  const runs = matching
    .map((report) => {
      try {
        return extractRunDiagnostics(report);
      } catch (error) {
        throw new Error(
          `${report.fileName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })
    .sort((left, right) => {
      const leftKey = left.fetchTime ?? left.sourceFile;
      const rightKey = right.fetchTime ?? right.sourceFile;
      return leftKey.localeCompare(rightKey);
    })
    .map((run, index) => ({ ...run, run: index + 1 }));

  const medians = medianSummary(runs);
  return {
    schemaVersion: 1,
    generatedAt,
    sourceDirectory: sourceDirectory === null ? null : resolve(sourceDirectory),
    targetPath: normalizedPath,
    expectedRuns,
    runCount: runs.length,
    runs,
    median: medians,
    attribution: attributionSummary(runs, medians),
  };
}

function markdownEscape(value) {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function formatMs(value) {
  return value === null ? "—" : `${value.toFixed(1)}`;
}

function formatBytes(value) {
  return value === null ? "—" : `${(value / 1024).toFixed(1)} KiB`;
}

function phaseCell(phases) {
  return PHASES.map((phase) => formatMs(phases[phase.key])).join(" / ");
}

function graphqlRelationLabel(relation) {
  return {
    "before-lcp": "before LCP",
    "after-lcp": "after LCP",
    none: "none",
    unknown: "unknown",
  }[relation];
}

function graphqlCell(graphql) {
  return [
    graphql.fetchCount ?? "—",
    `${formatMs(graphql.medianDurationMs)} / ${formatMs(graphql.maxDurationMs)}`,
    graphql.completionRelativeToLcp
      ? graphqlRelationLabel(graphql.completionRelativeToLcp)
      : "—",
  ].join(" · ");
}

function runMarkdownRow(run) {
  const element =
    run.lcpElement.selector && run.lcpElement.nodeLabel
      ? `${run.lcpElement.selector} · ${run.lcpElement.nodeLabel}`
      : (run.lcpElement.selector ?? run.lcpElement.nodeLabel ?? "unavailable");
  return [
    run.run,
    markdownEscape(run.fetchTime),
    formatMs(run.lcpMs),
    phaseCell(run.lcpPhases),
    markdownEscape(element),
    `${run.document.statusCode} · ${formatBytes(run.document.transferBytes)} / ${formatBytes(run.document.resourceBytes)}`,
    `${formatMs(run.serverResponseTimeMs)} / ${formatMs(run.totalBlockingTimeMs)}`,
    `${formatMs(run.mainThread.totalMs)} / ${formatMs(run.mainThread.scriptEvaluationMs)}`,
    `${run.longTasks.count ?? "—"} / ${formatMs(run.longTasks.maxDurationMs)}`,
    formatMs(run.benchmarkIndex),
    graphqlCell(run.graphql),
  ];
}

function medianMarkdownRow(summary) {
  return [
    "**Median**",
    "—",
    formatMs(summary.lcpMs),
    phaseCell(summary.lcpPhases),
    "—",
    `— · ${formatBytes(summary.document.transferBytes)} / ${formatBytes(summary.document.resourceBytes)}`,
    `${formatMs(summary.serverResponseTimeMs)} / ${formatMs(summary.totalBlockingTimeMs)}`,
    `${formatMs(summary.mainThread.totalMs)} / ${formatMs(summary.mainThread.scriptEvaluationMs)}`,
    `${formatMs(summary.longTasks.count)} / ${formatMs(summary.longTasks.maxDurationMs)}`,
    formatMs(summary.benchmarkIndex),
    `${formatMs(summary.graphql.fetchCount)} · ${formatMs(summary.graphql.medianDurationMs)} / ${formatMs(summary.graphql.maxDurationMs)} · —`,
  ];
}

export function formatMarkdown(analysis) {
  const headers = [
    "Run",
    "Fetch time",
    "LCP ms",
    "Phases ms",
    "LCP element",
    "Document",
    "Server / TBT ms",
    "Main / eval ms",
    "Long count / max ms",
    "Benchmark",
    "GraphQL count · median/max ms · completion",
  ];
  const rows = [
    ...analysis.runs.map(runMarkdownRow),
    medianMarkdownRow(analysis.median),
  ];
  const table = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

  const dominant = analysis.attribution.dominantPhase;
  const graphql = analysis.attribution.graphqlCompletion;
  return [
    "# Pool-detail Lighthouse diagnostics",
    "",
    `- Target pathname: \`${analysis.targetPath}\``,
    `- Reports: ${analysis.runCount} (expected ${analysis.expectedRuns})`,
    `- Generated: ${analysis.generatedAt}`,
    "",
    table,
    "",
    "_Phases: TTFB / load delay / load time / render delay. Document: HTTP status · transfer/resource bytes. CPU: server response / TBT and total main-thread / script evaluation. GraphQL completion compares the final GraphQL network end time with LCP._",
    "",
    "## Attribution summary",
    "",
    `- Median LCP: **${formatMs(analysis.median.lcpMs)} ms**.`,
    dominant
      ? `- Dominant median LCP phase: **${dominant.label}** at **${formatMs(dominant.medianMs)} ms**.`
      : "- Dominant median LCP phase: **unavailable**.",
    `- GraphQL completion vs LCP: **${graphql.beforeLcpRuns} before**, **${graphql.afterLcpRuns} after**, ${graphql.noGraphqlRuns} with no GraphQL fetches, ${graphql.unknownRuns} unavailable.`,
    "",
  ].join("\n");
}

function writeOutputs(analysis, outputJson, outputMarkdown) {
  const jsonPath = resolve(outputJson);
  const markdownPath = resolve(outputMarkdown);
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
  writeFileSync(markdownPath, formatMarkdown(analysis));
}

export function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const reports = readLighthouseReports(options.dir);
  const analysis = analyzeReports(reports, {
    targetPath: options.path,
    expectedRuns: options.expectedRuns,
    sourceDirectory: options.dir,
  });
  writeOutputs(analysis, options.outputJson, options.outputMarkdown);
  console.log(
    `Wrote ${analysis.runCount} pool-detail Lighthouse run(s) to ${resolve(options.outputJson)} and ${resolve(options.outputMarkdown)}`,
  );
  return analysis;
}

export function main(argv = process.argv.slice(2)) {
  try {
    runCli(argv);
    return 0;
  } catch (error) {
    console.error(
      `::error::Lighthouse pool diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
