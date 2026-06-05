import { describe, expect, it } from "vitest";
import { IntegrationProbeSnapshotSchema } from "../integration-probes";

describe("IntegrationProbeSnapshotSchema", () => {
  it("accepts the current snapshot contract", () => {
    const result = IntegrationProbeSnapshotSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-06-01T00:00:00.000Z",
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
        partialChainChecks: 0,
        failingChainChecks: 0,
        needsKeyChainChecks: 0,
        unsupportedChainChecks: 0,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts aggregator volume signals", () => {
    const result = IntegrationProbeSnapshotSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-06-01T00:00:00.000Z",
      amountUsd: "1",
      takerAddress: "0x000000000000000000000000000000000000dEaD",
      pairSource: {
        kind: "hasura",
        hasuraUrlConfigured: true,
        note: "fixture",
      },
      chains: [],
      aggregators: [
        {
          id: "fixture",
          label: "Fixture",
          kind: "dex",
          tier: 1,
          volumeSignal: {
            window: "30d",
            category: "dex-aggregator",
            valueUsd: 123,
            sourceLabel: "DefiLlama DEX aggregators",
            sourceUrl: "https://api.llama.fi/overview/aggregators",
            sourceProtocol: "Fixture",
            note: null,
          },
          credentialEnv: [],
          researchNote: "fixture",
          chains: [],
        },
      ],
      summary: {
        aggregators: 1,
        chainChecks: 0,
        passingChainChecks: 0,
        partialChainChecks: 0,
        failingChainChecks: 0,
        needsKeyChainChecks: 0,
        unsupportedChainChecks: 0,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.aggregators[0]?.volumeSignal?.valueUsd).toBe(123);
  });

  it("defaults live-debug pair fields for older v1 snapshots", () => {
    const result = IntegrationProbeSnapshotSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-06-01T00:00:00.000Z",
      amountUsd: "1",
      takerAddress: "0x000000000000000000000000000000000000dEaD",
      pairSource: {
        kind: "hasura",
        hasuraUrlConfigured: true,
        note: "fixture",
      },
      chains: [],
      aggregators: [
        {
          id: "fixture",
          label: "Fixture",
          kind: "dex",
          tier: 1,
          credentialEnv: [],
          researchNote: "fixture",
          chains: [
            {
              chainId: 42220,
              chainSlug: "celo",
              chainLabel: "Celo",
              status: "fail",
              pairCoverage: { passed: 0, total: 1 },
              blockingReason: "fixture",
              nextStep: "fixture",
              pairs: [
                {
                  pairId: "42220:EURm-USDm:42220-0xpool",
                  poolId: "42220-0xpool",
                  direction: "base-to-usdm",
                  sellSymbol: "EURm",
                  buySymbol: "USDm",
                  status: "fail",
                  evidence: [],
                  sourceLabels: [],
                  txTarget: null,
                  downstreamProvider: null,
                  requestUrl: null,
                  error: "fixture",
                },
              ],
            },
          ],
        },
      ],
      summary: {
        aggregators: 1,
        chainChecks: 1,
        passingChainChecks: 0,
        failingChainChecks: 1,
        needsKeyChainChecks: 0,
        unsupportedChainChecks: 0,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.aggregators[0]?.volumeSignal).toBeNull();
    expect(result.data?.summary.partialChainChecks).toBe(0);
    expect(
      result.data?.aggregators[0]?.chains[0]?.pairs[0]?.httpStatus,
    ).toBeNull();
    expect(
      result.data?.aggregators[0]?.chains[0]?.pairs[0]?.routeVariant,
    ).toBeNull();
    expect(
      result.data?.aggregators[0]?.chains[0]?.pairs[0]?.routeAmountUsd,
    ).toBeNull();
    expect(
      result.data?.aggregators[0]?.chains[0]?.pairs[0]?.attemptCount,
    ).toBeNull();
  });

  it("rejects unknown statuses so stale writers do not render silently", () => {
    const result = IntegrationProbeSnapshotSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "2026-06-01T00:00:00.000Z",
      amountUsd: "1",
      takerAddress: "0x000000000000000000000000000000000000dEaD",
      pairSource: {
        kind: "hasura",
        hasuraUrlConfigured: true,
        note: "fixture",
      },
      chains: [],
      aggregators: [
        {
          id: "bad",
          label: "Bad",
          kind: "dex",
          tier: 1,
          credentialEnv: [],
          researchNote: "fixture",
          chains: [
            {
              chainId: 42220,
              chainSlug: "celo",
              chainLabel: "Celo",
              status: "maybe",
              pairCoverage: { passed: 0, total: 0 },
              blockingReason: null,
              nextStep: null,
              pairs: [],
            },
          ],
        },
      ],
      summary: {
        aggregators: 1,
        chainChecks: 1,
        passingChainChecks: 0,
        failingChainChecks: 0,
        needsKeyChainChecks: 0,
        unsupportedChainChecks: 0,
      },
    });

    expect(result.success).toBe(false);
  });
});
