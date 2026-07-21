// Shared fixtures and GraphQL request-mock plumbing for the
// `fetchNetworkData` characterization suites (#1055):
//   - fetch.characterization.sources.test.ts
//   - fetch.characterization.windows.test.ts
// Not a .test file, so vitest doesn't collect it as a suite. Each suite
// still declares its own `vi.mock` blocks — those are hoisted per test
// file by the vitest transform and cannot live in a shared module.

import { GraphQLClient } from "@/lib/graphql-fetch";
import { vi } from "vitest";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

export const CELO_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

// Chain 143 — the only chain `usesRuntimeStrategyProbe` treats as a fallback
// strategy candidate (`strategy-probe-scope.ts`).
export const MONAD_NETWORK: Network = {
  ...CELO_NETWORK,
  id: "monad-mainnet",
  label: "Monad",
  chainId: 143,
  hasuraUrl: "https://hasura-monad.example.com/v1/graphql",
  explorerBaseUrl: "https://monadscan.com",
};

export const WINDOWS = {
  w24h: { from: 0, to: 1000 },
  w7d: { from: 0, to: 7000 },
  w30d: { from: 0, to: 30000 },
};

/** Oracle-eligible FPMM pool — enough for `buildOracleRateMap` to price the
 * FX leg so the happy-path fee aggregation doesn't trip the empty-rates
 * guard (mirrors the fixture in `use-protocol-fees.test.ts`). */
export function makePool(id: string, overrides: Partial<Pool> = {}): Pool {
  return {
    id,
    chainId: 42220,
    token0: "USDm",
    token1: "EURm",
    source: "FPMM",
    oraclePrice: "1140000000000000000000000",
    oracleOk: true,
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    ...overrides,
  } as Pool;
}

// Maps each query's operation name to its GraphQL response key and a
// default (empty, successful) response — so a test only needs to override
// the one source it cares about and every other source resolves cleanly.
const DEFAULT_RESPONSES: Record<string, Record<string, unknown>> = {
  AllPoolsWithHealth: { Pool: [] },
  AllPoolsBreachRollup: { Pool: [] },
  AllPoolsHealthCursor: { Pool: [] },
  AllPoolsRebalanceThresholdsKnown: { Pool: [] },
  AllPoolsVpOracleFreshness: { Pool: [] },
  AllPoolsVpDeprecation: { BiPoolExchange: [] },
  AllPoolsVpLifecycleDeprecation: { VirtualPoolLifecycle: [] },
  AllOlsPools: { OlsPool: [] },
  AllActivePoolLiquidityStrategies: { PoolLiquidityStrategy: [] },
  AllCdpPools: { CdpPool: [] },
  PoolDailyFeeSnapshotsPage: { PoolDailyFeeSnapshot: [] },
  PoolDailySnapshotsAll: { PoolDailySnapshot: [] },
  BrokerDailySnapshotsAll: { BrokerDailySnapshot: [] },
  UniqueLpAddresses: { LiquidityPosition: [] },
};

function extractQuery(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "document" in arg) {
    const doc = (arg as { document: unknown }).document;
    if (typeof doc === "string") return doc;
  }
  return "";
}

function queryNameOf(document: string): string {
  return /query\s+(\w+)/.exec(document)?.[1] ?? "";
}

type Reply = Record<string, unknown> | { reject: unknown };

export function reject(reason: unknown): Reply {
  return { reject: reason };
}

function isRejectReply(reply: Reply): reply is { reject: unknown } {
  return "reject" in reply;
}

/**
 * Installs a per-operation-name request mock. `overrides[name]` may be a
 * fixed reply, or a function of the call index (0-based, per operation name)
 * for pagination sequences. Any operation not overridden gets its default
 * empty/successful response from `DEFAULT_RESPONSES`.
 */
export function installGraphQLMock(
  overrides: Partial<Record<string, Reply | ((callIndex: number) => Reply)>>,
): void {
  const callCounts = new Map<string, number>();
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((arg: unknown) => {
    const name = queryNameOf(extractQuery(arg));
    const index = callCounts.get(name) ?? 0;
    callCounts.set(name, index + 1);
    const override = overrides[name];
    const reply: Reply =
      override === undefined
        ? (DEFAULT_RESPONSES[name] ?? {})
        : typeof override === "function"
          ? override(index)
          : override;
    return isRejectReply(reply)
      ? Promise.reject(reply.reject)
      : Promise.resolve(reply);
  });
}
