const DEFAULT_HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";

export const HASURA_URL = process.env.HASURA_URL || DEFAULT_HASURA_URL;

const rawPollInterval = Number(process.env.POLL_INTERVAL_MS || "30000");
export const POLL_INTERVAL_MS =
  Number.isFinite(rawPollInterval) && rawPollInterval >= 1000
    ? rawPollInterval
    : 30000;

const rawPort = Number(process.env.PORT || "8080");
export const PORT =
  Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8080;

export const POOL_PAIR_LABELS: Record<string, string> = {
  "42220-0x8c0014afe032e4574481d8934504100bf23fcb56": "USDm/GBPm",
  "42220-0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d": "USDm/axlUSDC",
  "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e": "USDm/USDC",
  "42220-0x0feba760d93423d127de1b6abecdb60e5253228d": "USDT/USDm",
};

export function pairLabel(poolId: string): string {
  return POOL_PAIR_LABELS[poolId] ?? poolId;
}
