import { describe, expect, it } from "vitest";
import { writeSnapshotToUpstash } from "../upstash.js";
import type { IntegrationProbeSnapshot } from "../types.js";

describe("writeSnapshotToUpstash", () => {
  it("writes latest and dated history keys through the REST pipeline", async () => {
    const calls: Array<{
      input: string | URL | Request;
      init: RequestInit | undefined;
    }> = [];
    const result = await writeSnapshotToUpstash({
      snapshot: fixtureSnapshot(),
      env: {
        UPSTASH_REDIS_REST_URL: "https://redis.test/",
        UPSTASH_REDIS_REST_TOKEN: "token",
      },
      fetcher: async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify([{ result: "OK" }, { result: "OK" }]),
        );
      },
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as string[][];
    expect(result).toEqual({
      latestKey: "integration-probes:latest",
      historyKey: "integration-probes:history:2026-06-01",
    });
    expect(String(calls[0]?.input)).toBe("https://redis.test/pipeline");
    expect(body.map((command) => command.slice(0, 2))).toEqual([
      ["SET", "integration-probes:latest"],
      ["SET", "integration-probes:history:2026-06-01"],
    ]);
    expect(body[1]?.slice(3)).toEqual(["EX", String(90 * 24 * 60 * 60)]);
    expect(JSON.parse(body[0]?.[2] ?? "{}")).toEqual(fixtureSnapshot());
  });

  it("adds a timeout signal to Upstash writes", async () => {
    const signals: AbortSignal[] = [];
    await writeSnapshotToUpstash({
      snapshot: fixtureSnapshot(),
      env: {
        UPSTASH_REDIS_REST_URL: "https://redis.test",
        UPSTASH_REDIS_REST_TOKEN: "token",
      },
      fetcher: async (_input, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Response(
          JSON.stringify([{ result: "OK" }, { result: "OK" }]),
        );
      },
    });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("refuses to publish contract-fallback snapshots", async () => {
    await expect(
      writeSnapshotToUpstash({
        snapshot: fixtureSnapshot({
          pairSource: {
            kind: "contracts-fallback",
            hasuraUrlConfigured: false,
            note: "dry-run fallback",
          },
        }),
        env: {
          UPSTASH_REDIS_REST_URL: "https://redis.test",
          UPSTASH_REDIS_REST_TOKEN: "token",
        },
        fetcher: async () => new Response("{}"),
      }),
    ).rejects.toThrow("without Hasura-derived active pairs");
  });

  it("reports missing Upstash credentials explicitly", async () => {
    await expect(
      writeSnapshotToUpstash({
        snapshot: fixtureSnapshot(),
        env: {},
        fetcher: async () => new Response("{}"),
      }),
    ).rejects.toThrow("Upstash Redis not configured");
  });

  it("surfaces failed Upstash writes", async () => {
    await expect(
      writeSnapshotToUpstash({
        snapshot: fixtureSnapshot(),
        env: {
          UPSTASH_REDIS_REST_URL: "https://redis.test",
          UPSTASH_REDIS_REST_TOKEN: "token",
        },
        fetcher: async () => new Response("{}", { status: 500 }),
      }),
    ).rejects.toThrow("Upstash write failed: HTTP 500");
  });

  it("surfaces per-command pipeline errors", async () => {
    await expect(
      writeSnapshotToUpstash({
        snapshot: fixtureSnapshot(),
        env: {
          UPSTASH_REDIS_REST_URL: "https://redis.test",
          UPSTASH_REDIS_REST_TOKEN: "token",
        },
        fetcher: async () =>
          new Response(
            JSON.stringify([
              { result: "OK" },
              { error: "ERR invalid expire time" },
            ]),
          ),
      }),
    ).rejects.toThrow(
      "Upstash write failed: command 2: ERR invalid expire time",
    );
  });
});

function fixtureSnapshot(
  overrides: Partial<IntegrationProbeSnapshot> = {},
): IntegrationProbeSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-01T12:00:00.000Z",
    amountUsd: "1",
    takerAddress: "0x000000000000000000000000000000000000dEaD",
    pairSource: {
      kind: "hasura",
      hasuraUrlConfigured: true,
      note: "fixture",
    },
    chains: [],
    aggregators: [],
    summary: {
      aggregators: 0,
      chainChecks: 0,
      passingChainChecks: 0,
      failingChainChecks: 0,
      needsKeyChainChecks: 0,
      unsupportedChainChecks: 0,
    },
    ...overrides,
  };
}
