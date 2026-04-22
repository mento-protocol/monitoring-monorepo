import type { Pool } from "generated";
import { DEFAULT_ORACLE_FIELDS } from "../../src/pool";

/**
 * Shared Pool fixture builder for indexer tests. Previously duplicated
 * across four test files with small drift; consolidated here so a new
 * required schema field only needs one edit.
 *
 * Defaults to a FPMM pool with a fresh oracle and a 50%-equivalent
 * rebalance threshold (5000 bps). Override any field via `overrides`.
 */
export function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "42220-0xtest",
    chainId: 42220,
    token0: "0xtok0",
    token1: "0xtok1",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    reserves0: 0n,
    reserves1: 0n,
    swapCount: 0,
    notionalVolume0: 0n,
    notionalVolume1: 0n,
    rebalanceCount: 0,
    ...DEFAULT_ORACLE_FIELDS,
    oracleOk: true,
    rebalanceThreshold: 5000,
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
    ...overrides,
  };
}
