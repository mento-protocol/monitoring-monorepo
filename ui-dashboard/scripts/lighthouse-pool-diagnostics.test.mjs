import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  analyzeReports,
  extractRunDiagnostics,
  formatMarkdown,
  parseArgs,
  readLighthouseReports,
  runCli,
} from "./lighthouse-pool-diagnostics.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./lighthouse-pool-diagnostics.mjs", import.meta.url),
);
const ORIGIN = "https://monitoring-example.vercel.app";
const POOL_PATH = "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";

function phaseNode() {
  return {
    type: "node",
    selector: "dl.grid > div > dd.flex > span.font-mono",
    nodeLabel: "ref 1.000000 / actual 0.999750",
  };
}

function legacyLcpElementAudit() {
  return {
    details: {
      type: "list",
      items: [
        {
          type: "table",
          headings: [{ key: "node", valueType: "node", label: "Element" }],
          items: [{ node: phaseNode() }],
        },
        {
          type: "table",
          headings: [
            { key: "phase", valueType: "text", label: "Phase" },
            { key: "percent", valueType: "text", label: "% of LCP" },
            { key: "timing", valueType: "ms", label: "Timing" },
          ],
          items: [
            { phase: "TTFB", timing: 160, percent: "10%" },
            { phase: "Load Delay", timing: 20, percent: "1%" },
            { phase: "Load Time", timing: 30, percent: "2%" },
            { phase: "Render Delay", timing: 1_390, percent: "87%" },
          ],
        },
      ],
    },
  };
}

function insightFallbackAudits() {
  return {
    "largest-contentful-paint-element": {
      details: {
        type: "list",
        items: [
          {
            type: "table",
            items: [{ node: phaseNode() }],
          },
        ],
      },
    },
    "lcp-phases-insight": {
      details: {
        type: "list",
        items: [
          {
            type: "table",
            items: [
              {
                phase: "timeToFirstByte",
                label: "Time to first byte",
                duration: 90,
              },
              {
                phase: "resourceLoadDelay",
                label: "Resource load delay",
                duration: 15,
              },
              {
                phase: "resourceLoadDuration",
                label: "Resource load duration",
                duration: 25,
              },
              {
                phase: "elementRenderDelay",
                label: "Element render delay",
                duration: 1_470,
              },
            ],
          },
          phaseNode(),
        ],
      },
    },
  };
}

function makeLhr({
  path = POOL_PATH,
  query = "",
  fetchTime = "2026-07-16T12:00:00.000Z",
  lcpMs = 1_600,
  phaseShape = "legacy",
  includeOptionals = true,
  runtimeCode = "NO_ERROR",
  documentStatus = 200,
  graphqlTimings = [
    [400, 600],
    [700, 1_100],
    [900, 1_500],
  ],
} = {}) {
  const finalUrl = new URL(`${path}${query}`, ORIGIN).href;
  const graphqlUrl = "https://indexer.hyperindex.xyz/example/v1/graphql";
  const requests = [
    {
      url: finalUrl,
      resourceType: "Document",
      statusCode: documentStatus,
      transferSize: 14_000,
      resourceSize: 86_000,
      networkRequestTime: 10,
      networkEndTime: 320,
    },
    {
      url: graphqlUrl,
      resourceType: "Preflight",
      statusCode: 204,
      networkRequestTime: 350,
      networkEndTime: 390,
    },
    ...graphqlTimings.map(([networkRequestTime, networkEndTime]) => ({
      url: graphqlUrl,
      resourceType: "Fetch",
      statusCode: 200,
      networkRequestTime,
      networkEndTime,
      transferSize: 1_000,
      resourceSize: 4_000,
    })),
  ];
  const audits = {
    "largest-contentful-paint": { numericValue: lcpMs },
    "network-requests": { details: { type: "table", items: requests } },
  };

  if (phaseShape === "legacy") {
    audits["largest-contentful-paint-element"] = legacyLcpElementAudit();
  } else if (phaseShape === "insight") {
    Object.assign(audits, insightFallbackAudits());
  }

  if (includeOptionals) {
    Object.assign(audits, {
      "server-response-time": { numericValue: 20 },
      "total-blocking-time": { numericValue: 45 },
      "mainthread-work-breakdown": {
        numericValue: 720,
        details: {
          items: [
            {
              group: "scriptEvaluation",
              groupLabel: "Script Evaluation",
              duration: 480,
            },
            { group: "other", groupLabel: "Other", duration: 240 },
          ],
        },
      },
      "long-tasks": {
        details: {
          items: [
            { duration: 65, startTime: 500 },
            { duration: 90, startTime: 900 },
          ],
        },
      },
    });
  }

  return {
    fetchTime,
    requestedUrl: finalUrl,
    mainDocumentUrl: finalUrl,
    finalUrl,
    runtimeError: { code: runtimeCode },
    environment: includeOptionals ? { benchmarkIndex: 4_800 } : undefined,
    audits,
  };
}

function tempFixture() {
  const root = mkdtempSync(join(tmpdir(), "lighthouse-pool-diagnostics-"));
  const reports = join(root, ".lighthouseci");
  const output = join(root, "reports");
  mkdirSync(reports);
  return {
    root,
    reports,
    outputJson: join(output, "diagnostics.json"),
    outputMarkdown: join(output, "diagnostics.md"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeLhr(directory, index, lhr) {
  writeFileSync(
    join(directory, `lhr-${String(index).padStart(2, "0")}.json`),
    JSON.stringify(lhr),
  );
}

function cliArgs(fixture, path = POOL_PATH, expectedRuns = 3) {
  return [
    "--dir",
    fixture.reports,
    "--path",
    path,
    "--expected-runs",
    String(expectedRuns),
    "--output-json",
    fixture.outputJson,
    "--output-markdown",
    fixture.outputMarkdown,
  ];
}

test("defaults expected runs to three", () => {
  const parsed = parseArgs([
    "--dir",
    ".lighthouseci",
    "--path",
    `${POOL_PATH}?chainId=42220`,
    "--output-json",
    "diagnostics.json",
    "--output-markdown",
    "diagnostics.md",
  ]);

  assert.equal(parsed.expectedRuns, 3);
  assert.equal(parsed.path, `${POOL_PATH}?chainId=42220`);
});

test("extracts a real Lighthouse 12 legacy LCP phase shape", () => {
  const run = extractRunDiagnostics({
    fileName: "lhr-legacy.json",
    lhr: makeLhr(),
  });

  assert.equal(run.lcpMs, 1_600);
  assert.deepEqual(run.lcpPhases, {
    source: "largest-contentful-paint-element",
    ttfbMs: 160,
    loadDelayMs: 20,
    loadTimeMs: 30,
    renderDelayMs: 1_390,
  });
  assert.equal(
    run.lcpElement.selector,
    "dl.grid > div > dd.flex > span.font-mono",
  );
  assert.equal(run.document.statusCode, 200);
  assert.equal(run.document.transferBytes, 14_000);
  assert.equal(run.document.resourceBytes, 86_000);
  assert.equal(run.serverResponseTimeMs, 20);
  assert.equal(run.totalBlockingTimeMs, 45);
  assert.equal(run.mainThread.totalMs, 720);
  assert.equal(run.mainThread.scriptEvaluationMs, 480);
  assert.deepEqual(run.longTasks, { count: 2, maxDurationMs: 90 });
  assert.equal(run.benchmarkIndex, 4_800);
  assert.deepEqual(run.graphql, {
    fetchCount: 3,
    medianDurationMs: 400,
    maxDurationMs: 600,
    lastEndTimeMs: 1_500,
    completionRelativeToLcp: "before-lcp",
  });
});

test("falls back to the Lighthouse insight LCP phase shape", () => {
  const run = extractRunDiagnostics({
    fileName: "lhr-insight.json",
    lhr: makeLhr({ phaseShape: "insight" }),
  });

  assert.deepEqual(run.lcpPhases, {
    source: "lcp-phases-insight",
    ttfbMs: 90,
    loadDelayMs: 15,
    loadTimeMs: 25,
    renderDelayMs: 1_470,
  });
  assert.equal(run.lcpElement.nodeLabel, "ref 1.000000 / actual 0.999750");
});

test("tolerates absent optional diagnostics", () => {
  const run = extractRunDiagnostics({
    fileName: "lhr-minimal.json",
    lhr: makeLhr({
      phaseShape: "none",
      includeOptionals: false,
      graphqlTimings: [],
    }),
  });

  assert.deepEqual(run.lcpPhases, {
    source: null,
    ttfbMs: null,
    loadDelayMs: null,
    loadTimeMs: null,
    renderDelayMs: null,
  });
  assert.deepEqual(run.lcpElement, { selector: null, nodeLabel: null });
  assert.equal(run.serverResponseTimeMs, null);
  assert.equal(run.totalBlockingTimeMs, null);
  assert.deepEqual(run.mainThread, {
    totalMs: null,
    scriptEvaluationMs: null,
  });
  assert.deepEqual(run.longTasks, { count: null, maxDurationMs: null });
  assert.equal(run.benchmarkIndex, null);
  assert.deepEqual(run.graphql, {
    fetchCount: 0,
    medianDurationMs: null,
    maxDurationMs: null,
    lastEndTimeMs: null,
    completionRelativeToLcp: "none",
  });
});

test("filters by exact pathname and query marker", () => {
  const reports = [
    {
      fileName: "lhr-01.json",
      lhr: makeLhr({
        query: "?lhci=fixture",
        fetchTime: "2026-07-16T12:00:01.000Z",
        lcpMs: 1_400,
      }),
    },
    {
      fileName: "lhr-02.json",
      lhr: makeLhr({
        query: "?lhci=fixture",
        fetchTime: "2026-07-16T12:00:02.000Z",
        lcpMs: 1_600,
      }),
    },
    {
      fileName: "lhr-03.json",
      lhr: makeLhr({
        query: "?lhci=fixture",
        fetchTime: "2026-07-16T12:00:03.000Z",
        lcpMs: 1_800,
      }),
    },
    {
      fileName: "lhr-live.json",
      lhr: makeLhr({ query: "?lhci=live" }),
    },
    {
      fileName: "lhr-other.json",
      lhr: makeLhr({ path: `${POOL_PATH}-other` }),
    },
  ];

  const analysis = analyzeReports(reports, {
    targetPath: `${POOL_PATH}?lhci=fixture`,
    expectedRuns: 3,
    generatedAt: "2026-07-16T13:00:00.000Z",
  });

  assert.equal(analysis.runCount, 3);
  assert.equal(analysis.targetPath, `${POOL_PATH}?lhci=fixture`);
  assert.equal(analysis.median.lcpMs, 1_600);
  assert.deepEqual(analysis.attribution.dominantPhase, {
    key: "renderDelayMs",
    label: "Render Delay",
    medianMs: 1_390,
  });
  assert.deepEqual(analysis.attribution.graphqlCompletion, {
    beforeLcpRuns: 2,
    afterLcpRuns: 1,
    noGraphqlRuns: 0,
    unknownRuns: 0,
  });
  const markdown = formatMarkdown(analysis);
  assert.match(markdown, /\*\*Median\*\*/);
  assert.match(markdown, /ref 1\.000000 \/ actual 0\.999750/);
  assert.match(markdown, /Dominant median LCP phase: \*\*Render Delay\*\*/);
  assert.match(markdown, /\*\*2 before\*\*, \*\*1 after\*\*/);
});

test("the direct CLI writes JSON and Markdown artifacts", () => {
  const fixture = tempFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeLhr(
        fixture.reports,
        index,
        makeLhr({
          fetchTime: `2026-07-16T12:00:0${index}.000Z`,
          lcpMs: 1_500 + index * 100,
        }),
      );
    }

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, ...cliArgs(fixture)],
      {
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote 3 pool-detail Lighthouse run/);
    const json = JSON.parse(readFileSync(fixture.outputJson, "utf8"));
    const markdown = readFileSync(fixture.outputMarkdown, "utf8");
    assert.equal(json.targetPath, POOL_PATH);
    assert.equal(json.runCount, 3);
    assert.match(markdown, /# Pool-detail Lighthouse diagnostics/);
    assert.match(markdown, /## Attribution summary/);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed on a malformed JSON report", () => {
  const fixture = tempFixture();
  try {
    writeLhr(fixture.reports, 0, makeLhr());
    writeFileSync(join(fixture.reports, "lhr-bad.json"), "{not json");

    assert.throws(
      () => readLighthouseReports(fixture.reports),
      /Malformed Lighthouse report lhr-bad\.json/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when no Lighthouse reports exist", () => {
  const fixture = tempFixture();
  try {
    assert.throws(
      () => readLighthouseReports(fixture.reports),
      /No lhr-\*\.json reports found/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed on the wrong target run count", () => {
  const fixture = tempFixture();
  try {
    writeLhr(fixture.reports, 0, makeLhr());
    writeLhr(fixture.reports, 1, makeLhr());
    writeLhr(fixture.reports, 2, makeLhr({ path: "/pools" }));

    assert.throws(
      () => runCli(cliArgs(fixture)),
      /Expected exactly 3 Lighthouse reports .* found 2/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the exact target pathname is missing", () => {
  const fixture = tempFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeLhr(fixture.reports, index, makeLhr({ path: "/pools" }));
    }

    assert.throws(
      () => runCli(cliArgs(fixture)),
      /No Lighthouse reports matched exact path and query/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the required live/fixture query marker is missing", () => {
  const reports = [
    { fileName: "lhr-01.json", lhr: makeLhr({ query: "?lhci=live" }) },
    { fileName: "lhr-02.json", lhr: makeLhr({ query: "?lhci=live" }) },
    { fileName: "lhr-03.json", lhr: makeLhr({ query: "?lhci=live" }) },
  ];

  assert.throws(
    () =>
      analyzeReports(reports, {
        targetPath: `${POOL_PATH}?lhci=fixture`,
        expectedRuns: 3,
      }),
    /No Lighthouse reports matched exact path and query/,
  );
});

test("fails closed on a Lighthouse runtime failure", () => {
  const reports = [
    { fileName: "lhr-01.json", lhr: makeLhr() },
    {
      fileName: "lhr-02.json",
      lhr: makeLhr({ runtimeCode: "NO_FCP" }),
    },
    { fileName: "lhr-03.json", lhr: makeLhr() },
  ];

  assert.throws(
    () =>
      analyzeReports(reports, {
        targetPath: POOL_PATH,
        expectedRuns: 3,
      }),
    /lhr-02\.json: Lighthouse runtime error NO_FCP/,
  );
});

test("fails closed on a main-document HTTP failure", () => {
  const reports = [
    { fileName: "lhr-01.json", lhr: makeLhr() },
    {
      fileName: "lhr-02.json",
      lhr: makeLhr({ documentStatus: 503 }),
    },
    { fileName: "lhr-03.json", lhr: makeLhr() },
  ];

  assert.throws(
    () =>
      analyzeReports(reports, {
        targetPath: POOL_PATH,
        expectedRuns: 3,
      }),
    /lhr-02\.json: main document returned HTTP 503/,
  );
});

test("fails closed when the main-document request is missing", () => {
  const broken = makeLhr();
  broken.audits["network-requests"].details.items = broken.audits[
    "network-requests"
  ].details.items.filter((item) => item.resourceType !== "Document");
  const reports = [
    { fileName: "lhr-01.json", lhr: makeLhr() },
    { fileName: "lhr-02.json", lhr: broken },
    { fileName: "lhr-03.json", lhr: makeLhr() },
  ];

  assert.throws(
    () =>
      analyzeReports(reports, {
        targetPath: POOL_PATH,
        expectedRuns: 3,
      }),
    /network-requests audit has no matching main document/,
  );
});

test("fails closed when LCP is missing or invalid", () => {
  const reports = [
    { fileName: "lhr-01.json", lhr: makeLhr() },
    { fileName: "lhr-02.json", lhr: makeLhr({ lcpMs: 0 }) },
    { fileName: "lhr-03.json", lhr: makeLhr() },
  ];

  assert.throws(
    () =>
      analyzeReports(reports, {
        targetPath: POOL_PATH,
        expectedRuns: 3,
      }),
    /largest-contentful-paint has no positive numericValue/,
  );
});
