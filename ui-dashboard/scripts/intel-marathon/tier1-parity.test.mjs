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
      script === "before"
        ? join(cwd, "before.mjs")
        : join(here, "tier1-bulk-enrich.mjs");
    if (script === "before")
      writeFileSync(
        executable,
        readFileSync(join(here, "fixtures/tier1-before.mjs.txt")),
      );
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
describe("tier1 offline before/after CLI parity", () => {
  it.each(cases)("%s", (_name, scenario, args) => {
    const before = runOffline("before", scenario, args);
    const after = runOffline("after", scenario, args);
    expect(after).toEqual(before);
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
