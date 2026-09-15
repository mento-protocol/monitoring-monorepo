import { bench, describe } from "vitest";

import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import { buildDailySnapshotSlices, buildPoolVolumeMap } from "@/lib/volume";

const DAY_SECONDS = 86_400;
const NOW_SECONDS = 1_785_067_200; // 2026-07-26T12:00:00Z
const USD_M_ADDRESS = "0x0000000000000000000000000000000000000001";

const PRODUCTION_SHAPE = [
  { chainId: 137, poolCount: 3, rowCount: 21 },
  { chainId: 143, poolCount: 7, rowCount: 747 },
  { chainId: 42_220, poolCount: 20, rowCount: 2_429 },
] as const;

function makeNetwork(chainId: number): Network {
  const id =
    chainId === 137
      ? "polygon-mainnet"
      : chainId === 143
        ? "monad-mainnet"
        : "celo-mainnet";
  return {
    id,
    label: `Evidence chain ${chainId}`,
    chainId,
    contractsNamespace: null,
    hasuraUrl: "",
    hasuraSecret: "",
    explorerBaseUrl: "",
    tokenSymbols: { [USD_M_ADDRESS]: "USDm" },
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };
}

function makePools(chainId: number, poolCount: number): Pool[] {
  return Array.from({ length: poolCount }, (_, index) => ({
    id: `${chainId}-pool-${index}`,
    chainId,
    token0: USD_M_ADDRESS,
    token1: "0x0000000000000000000000000000000000000002",
    source: "fpmm",
    createdAtBlock: "1",
    createdAtTimestamp: "1",
    updatedAtBlock: "1",
    updatedAtTimestamp: String(NOW_SECONDS),
    token0Decimals: 18,
    token1Decimals: 18,
    tokenDecimalsKnown: true,
  }));
}

function makeRows(
  chainId: number,
  poolCount: number,
  rowCount: number,
): PoolSnapshotWindow[] {
  const todayMidnight = Math.floor(NOW_SECONDS / DAY_SECONDS) * DAY_SECONDS;
  return Array.from({ length: rowCount }, (_, index) => ({
    poolId: `${chainId}-pool-${index % poolCount}`,
    timestamp: String(
      todayMidnight - Math.floor(index / poolCount) * DAY_SECONDS,
    ),
    reserves0: "1000000000000000000",
    reserves1: "1000000000000000000",
    swapCount: 1,
    swapVolume0: "1000000000000000000",
    swapVolume1: "1000000000000000000",
  }));
}

const inputs = PRODUCTION_SHAPE.map(({ chainId, poolCount, rowCount }) => ({
  network: makeNetwork(chainId),
  pools: makePools(chainId, poolCount),
  rows: makeRows(chainId, poolCount, rowCount),
}));

function aggregateProductionShape(): {
  inputRows: number;
  rows24h: number;
  rows7d: number;
  rows30d: number;
  outputPools24h: number;
  outputPools7d: number;
  outputPools30d: number;
} {
  let inputRows = 0;
  let rows24h = 0;
  let rows7d = 0;
  let rows30d = 0;
  let outputPools24h = 0;
  let outputPools7d = 0;
  let outputPools30d = 0;

  for (const { network, pools, rows } of inputs) {
    const slices = buildDailySnapshotSlices(rows, NOW_SECONDS);
    inputRows += rows.length;
    rows24h += slices.snapshots.length;
    rows7d += slices.snapshots7d.length;
    rows30d += slices.snapshots30d.length;
    outputPools24h += buildPoolVolumeMap(
      slices.snapshots,
      pools,
      network,
      new Map(),
    ).size;
    outputPools7d += buildPoolVolumeMap(
      slices.snapshots7d,
      pools,
      network,
      new Map(),
    ).size;
    outputPools30d += buildPoolVolumeMap(
      slices.snapshots30d,
      pools,
      network,
      new Map(),
    ).size;
  }

  return {
    inputRows,
    rows24h,
    rows7d,
    rows30d,
    outputPools24h,
    outputPools7d,
    outputPools30d,
  };
}

const observedShape = aggregateProductionShape();
const expectedShape = {
  inputRows: 3_197,
  rows24h: 30,
  rows7d: 210,
  rows30d: 831,
  outputPools24h: 30,
  outputPools7d: 30,
  outputPools30d: 30,
};

if (JSON.stringify(observedShape) !== JSON.stringify(expectedShape)) {
  throw new Error(
    `Production-shape fixture drifted: ${JSON.stringify(observedShape)}`,
  );
}

console.info(`production-shape ${JSON.stringify(observedShape)}`);

for (let iteration = 0; iteration < 100; iteration += 1) {
  aggregateProductionShape();
}
const iterationsPerSample = 10;
const samplesMs = Array.from({ length: 100 }, () => {
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
    aggregateProductionShape();
  }
  return (performance.now() - startedAt) / iterationsPerSample;
}).sort((left, right) => left - right);
const timing = {
  samples: samplesMs.length,
  iterationsPerSample,
  medianMs: samplesMs[Math.floor(samplesMs.length / 2)],
  p95Ms: samplesMs[Math.floor(samplesMs.length * 0.95)],
};
console.info(`timing ${JSON.stringify(timing)}`);

describe("PoolDailySnapshot client aggregation at the 2026-07-26 production shape", () => {
  bench("slice and reduce 3,197 rows into 24h/7d/30d pool maps", () => {
    aggregateProductionShape();
  });
});
