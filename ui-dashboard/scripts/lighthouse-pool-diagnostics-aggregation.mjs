import {
  extractRunDiagnostics,
  median,
  reportFinalUrl,
} from "./lighthouse-pool-diagnostics-lhr.mjs";
import { resolve } from "node:path";
import {
  DEFAULT_EXPECTED_RUNS,
  normalizeTargetPath,
} from "./lighthouse-pool-diagnostics-validation.mjs";

export const PHASES = [
  { key: "ttfbMs", label: "TTFB" },
  { key: "loadDelayMs", label: "Load Delay" },
  { key: "loadTimeMs", label: "Load Time" },
  { key: "renderDelayMs", label: "Render Delay" },
];

export { median };

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
