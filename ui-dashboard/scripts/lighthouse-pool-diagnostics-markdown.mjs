import { PHASES } from "./lighthouse-pool-diagnostics-aggregation.mjs";

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
