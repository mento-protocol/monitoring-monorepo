import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const here = fileURLToPath(new URL(".", import.meta.url));
const offlinePreload = fileURLToPath(
  new URL("./fixtures/tier1-offline.mjs", import.meta.url),
);
export function runOffline(script, scenario = {}, args = []) {
  const cwd = mkdtempSync(join(tmpdir(), "tier1-parity-"));
  try {
    const config = join(cwd, "scenario.json");
    const transcript = join(cwd, "requests.jsonl");
    writeFileSync(config, JSON.stringify(scenario));
    writeFileSync(transcript, "");
    if (scenario.progress !== undefined) {
      mkdirSync(join(cwd, ".intel-marathon"));
      writeFileSync(
        join(
          cwd,
          `.intel-marathon/tier1-progress-${scenario.scope ?? "all"}.jsonl`,
        ),
        scenario.progress,
      );
    }
    const executable =
      script !== "after"
        ? join(cwd, "before.mjs")
        : join(here, "tier1-bulk-enrich.mjs");
    if (script === "before")
      writeFileSync(
        executable,
        readFileSync(join(here, "fixtures/tier1-before.mjs.txt")),
      );
    if (script === "parent") {
      writeFileSync(
        executable,
        readFileSync(join(here, "fixtures/tier1-parent.mjs.txt")),
      );
      writeFileSync(
        join(cwd, "tier1-progress.mjs"),
        readFileSync(join(here, "fixtures/tier1-parent-progress.mjs.txt")),
      );
      // These three modules are unchanged in the retry child.
      for (const name of ["discovery", "quota", "writes"])
        writeFileSync(
          join(cwd, `tier1-${name}.mjs`),
          readFileSync(join(here, `tier1-${name}.mjs`)),
        );
    }
    const result = spawnSync(
      process.execPath,
      ["--import", offlinePreload, executable, ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 10000,
        // No inherited secrets or NODE_OPTIONS. Both dry and normal runs use fake credentials.
        env: {
          PATH: process.env.PATH,
          UPSTASH_REDIS_REST_URL: "https://redis.invalid",
          UPSTASH_REDIS_REST_TOKEN: "offline",
          ARKHAM_API_KEY: "offline",
          TIER1_SCENARIO: config,
          TIER1_TRANSCRIPT: transcript,
        },
      },
    );
    if (result.error) throw result.error;
    const files = {};
    try {
      for (const name of readdirSync(join(cwd, ".intel-marathon")))
        files[name] = readFileSync(join(cwd, ".intel-marathon", name), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Error message and exit code remain exact. Stack frames move with the extraction.
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr.replace(/^\s+at .*\n?/gm, ""),
      requests: readFileSync(transcript, "utf8"),
      files,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const sources = {
  TraderAllTimeAggregate: [
    { trader: address(1), volumeUsdWei: "5" },
    { trader: address(2), volumeUsdWei: "4" },
  ],
};
const labels = {
  [address(1)]: {
    name: "Prior",
    source: "arkham",
    tags: ["arkham", "Curated"],
    isPublic: true,
    notes: "Human note",
    updatedAt: "old",
    createdAt: "original",
  },
};
const cases = [
  ["dry run", { sources }, ["--dry-run"]],
  ["enrichment", { sources }, []],
  ["refresh", { sources, labels }, []],
  [
    "resume preserves error skips",
    {
      sources,
      progress: JSON.stringify({ address: address(1), error: "failed" }) + "\n",
    },
    [],
  ],
  ["quota stop", { sources, usage: { totalCount: 949, totalLimit: 1000 } }, []],
  ["unknown quota", { sources, usage: {} }, []],
  ["unknown quota override", { sources, usage: {} }, ["--allow-unknown-quota"]],
  [
    "header floor",
    {
      sources,
      enrichments: [
        {
          data: { ethereum: { arkhamLabel: { name: "A" } } },
          headers: { "X-Intel-Datapoints-Remaining": "50" },
        },
      ],
    },
    [],
  ],
  [
    "no refresh and limit",
    { sources, labels },
    ["--no-refresh", "--limit", "1"],
  ],
  ["discovery failure", { sources, failedSource: "Trove" }, []],
  [
    "partial discovery",
    { sources, failedSource: "Trove" },
    ["--allow-partial-discovery"],
  ],
  ["write failure", { sources, pipelines: [{ status: 500 }] }, []],
  [
    "partial flush",
    {
      sources,
      labels,
      pipelines: [{ results: [{ result: 1 }] }, { status: 500 }],
    },
    [],
  ],
  [
    "contention",
    {
      sources,
      labels,
      pipelines: [
        { results: [{ result: 0 }] },
        { results: [{ result: [address(1)] }] },
      ],
    },
    [],
  ],
  [
    "rate limit retry",
    { sources, enrichments: [{ status: 429 }, { status: 404 }] },
    [],
  ],
  ["auth halt", { sources, enrichments: [{ status: 401 }] }, []],
  ["entitlement halt", { sources, enrichments: [{ status: 403 }] }, []],
  [
    "circuit breaker",
    {
      sources: {
        LiquidityPosition: Array.from({ length: 12 }, (_, i) => ({
          address: address(i + 1),
        })),
      },
      enrichments: Array.from({ length: 12 }, () => ({ status: 500 })),
    },
    [],
  ],
  [
    "near-floor poll",
    {
      sources: {
        LiquidityPosition: Array.from({ length: 101 }, (_, i) => ({
          address: address(i + 1),
        })),
      },
      usage: { totalCount: 0, totalLimit: 400 },
    },
    [],
  ],
  [
    "regular poll",
    {
      sources: {
        LiquidityPosition: Array.from({ length: 501 }, (_, i) => ({
          address: address(i + 1),
        })),
      },
    },
    [],
  ],
  ["missing numeric value", {}, ["--limit"]],
  ["invalid numeric value", {}, ["--quota-floor", "5O"]],
];
describe("tier1 offline parent/child CLI parity", () => {
  it.each(cases)("%s", (_name, scenario, args) => {
    const before = runOffline("parent", scenario, args);
    const after = runOffline("after", scenario, args);
    const updateGuidance = (text) =>
      text.replace(
        /resumes (the queue|it)\./g,
        "resumes unattempted work. Default resume skips recorded errors; add --retry-errors to retry them (additional Intel Label quota may be spent).",
      );
    expect(after).toEqual({
      ...before,
      stdout: updateGuidance(before.stdout),
      stderr: updateGuidance(before.stderr),
    });
    expect(after.stderr).not.toContain("Unexpected offline request");
  });
  it("halts failed writes without completing unwritten addresses", () => {
    const result = runOffline("after", {
      sources,
      pipelines: [{ status: 500 }],
    });
    expect(result.status).toBe(1);
    expect(result.files["tier1-progress-all.jsonl"]).toBeUndefined();
  });
  it("circuit breaker persists exactly ten errors and exits 3", () => {
    const result = runOffline(
      "after",
      cases.find(([name]) => name === "circuit breaker")[1],
    );
    expect(result.status).toBe(3);
    expect(
      result.files["tier1-progress-all.jsonl"].trim().split("\n"),
    ).toHaveLength(10);
  });
});

describe("offline retry CLI", () => {
  const errors = JSON.stringify({ address: address(1), error: "" }) + "\n";
  const lookups = (result) =>
    result.requests
      .split("\n")
      .filter((line) => line.includes("address_enriched"));
  it("retries eligible error-only histories, then skips their terminal success", () => {
    const first = runOffline("after", { sources, progress: errors }, [
      "--retry-errors",
    ]);
    expect(first.status).toBe(0);
    expect(lookups(first)).toHaveLength(2);
    expect(first.files["tier1-progress-all.jsonl"]).toContain(
      '"write":"written"',
    );
    const second = runOffline(
      "after",
      { sources, progress: first.files["tier1-progress-all.jsonl"] },
      ["--retry-errors"],
    );
    expect(second.status).toBe(0);
    expect(lookups(second)).toHaveLength(0);
    expect(second.files["tier1-progress-all.jsonl"]).toBe(
      first.files["tier1-progress-all.jsonl"],
    );
  });
  it("preserves default error skipping", () => {
    const result = runOffline("after", { sources, progress: errors });
    expect(lookups(result)).toHaveLength(1);
    expect(lookups(result)[0]).toContain(address(2));
  });
  it("keeps terminal records terminal in either order", () => {
    for (const progress of [
      errors + JSON.stringify({ address: address(1), write: "written" }) + "\n",
      JSON.stringify({ address: address(1), status: 404 }) + "\n" + errors,
    ]) {
      const result = runOffline("after", { sources, progress }, [
        "--retry-errors",
      ]);
      expect(lookups(result)).toHaveLength(1);
      expect(lookups(result)[0]).toContain(address(2));
    }
  });
  it("honors limits and quota floor", () => {
    const limited = runOffline("after", { sources, progress: errors }, [
      "--retry-errors",
      "--limit",
      "1",
    ]);
    expect(lookups(limited)).toHaveLength(1);
    expect(lookups(limited)[0]).toContain(address(1));
    const stopped = runOffline(
      "after",
      {
        sources,
        progress: errors,
        usage: { totalCount: 950, totalLimit: 1000 },
      },
      ["--retry-errors"],
    );
    expect(lookups(stopped)).toHaveLength(0);
    expect(stopped.files["tier1-progress-all.jsonl"]).toBe(errors);
  });
  it("does not expand discovery or override manual and no-refresh filters", () => {
    const progress =
      errors + JSON.stringify({ address: address(99), error: "failed" }) + "\n";
    const result = runOffline(
      "after",
      {
        sources,
        labels: {
          [address(1)]: { name: "Manual" },
          [address(2)]: { name: "Arkham", source: "arkham" },
        },
        progress,
      },
      ["--retry-errors", "--no-refresh"],
    );
    expect(lookups(result)).toHaveLength(0);
    expect(result.files["tier1-progress-all.jsonl"]).toBe(progress);
  });
  it("keeps scope files isolated", () => {
    const result = runOffline(
      "after",
      {
        sources,
        scope: "other",
        progress:
          JSON.stringify({ address: address(1), write: "written" }) + "\n",
      },
      ["--retry-errors", "--chain", "selected"],
    );
    expect(lookups(result)).toHaveLength(2);
    expect(result.files["tier1-progress-other.jsonl"]).toContain(
      '"write":"written"',
    );
    expect(result.files["tier1-progress-selected.jsonl"]).toBeDefined();
  });
  it("does not complete retried entries whose writes fail", () => {
    const result = runOffline(
      "after",
      { sources, progress: errors, pipelines: [{ status: 500 }] },
      ["--retry-errors"],
    );
    expect(result.status).toBe(1);
    expect(result.files["tier1-progress-all.jsonl"]).toBe(errors);
  });
  it("retains the ten-error circuit breaker and explains explicit retries", () => {
    const scenario = cases.find(([name]) => name === "circuit breaker")[1];
    const result = runOffline("after", { ...scenario, progress: errors }, [
      "--retry-errors",
    ]);
    expect(result.status).toBe(3);
    expect(lookups(result)).toHaveLength(10);
    expect(result.stderr).toContain(
      "Default resume skips recorded errors; add --retry-errors",
    );
    expect(result.stderr).toContain("additional Intel Label quota");
  });
});
