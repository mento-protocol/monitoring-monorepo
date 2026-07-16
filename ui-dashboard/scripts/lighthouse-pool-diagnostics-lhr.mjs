import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPORT_PATTERN = /^lhr-.*\.json$/;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function reportFinalUrl(lhr) {
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
