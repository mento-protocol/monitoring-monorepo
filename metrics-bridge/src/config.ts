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

// Display labels per pool. Convention: USDm always last when present, matching
// the dashboard's `poolName` helper. Spoke-chain tokens render as their
// canonical symbol (e.g. `USDmSpoke` → `USDm`) since operators know the token
// by its protocol name, not its per-chain contract name.
export const POOL_PAIR_LABELS: Record<string, string> = {
  // Celo mainnet (42220)
  "42220-0x8c0014afe032e4574481d8934504100bf23fcb56": "GBPm/USDm",
  "42220-0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d": "axlUSDC/USDm",
  "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e": "USDC/USDm",
  "42220-0x0feba760d93423d127de1b6abecdb60e5253228d": "USDT/USDm",
  "42220-0x1ad2ea06502919f935d9c09028df73a462979e29": "EURm/USDm",
  "42220-0x3aa7c431c06b10f7422e69d3e69b66807a6af696": "axlEUROC/EURm",

  // Monad mainnet (143)
  "143-0x93e15a22fda39fefccce82d387a09ccf030ead61": "EURm/USDm",
  "143-0xd0e9c1a718d2a693d41eacd4b2696180403ce081": "GBPm/USDm",
  "143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501": "AUSD/USDm",
  "143-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5": "USDC/USDm",
  "143-0x0a59be741ad49c6c2e0a2d30a57ed8f5ffa5deb8": "USDT0/USDm",
};

// chainId → canonical name used in Slack titles and dashboard URLs.
const CHAIN_NAMES: Record<number, string> = {
  42220: "celo",
  143: "monad",
  11142220: "celo-sepolia",
};

// chainId → block-explorer base URL. Matches the dashboard's network config
// (ui-dashboard/src/lib/networks.ts).
const BLOCK_EXPLORER_BASE_URLS: Record<number, string> = {
  42220: "https://celoscan.io",
  143: "https://monadscan.com",
  11142220: "https://celo-sepolia.blockscout.com",
};

export function pairLabel(poolId: string): string {
  return POOL_PAIR_LABELS[poolId] ?? poolId;
}

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? String(chainId);
}

// Extract the bare contract address from a pool id of the form
// `{chainId}-{0xaddress}`. Returns the input unchanged if no prefix.
export function poolAddress(poolId: string): string {
  const dash = poolId.indexOf("-");
  return dash >= 0 ? poolId.slice(dash + 1) : poolId;
}

// `0x93e15a22fda39fefccce82d387a09ccf030ead61` → `0x93e1…ead61`.
// Keeps leading `0x` + 4 nibbles and trailing 4 nibbles so both ends of the
// address are distinguishable in Slack without occupying 40+ characters.
export function shortAddress(address: string): string {
  if (!address.startsWith("0x") || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function blockExplorerUrl(chainId: number, address: string): string {
  const base = BLOCK_EXPLORER_BASE_URLS[chainId];
  if (!base) return "";
  return `${base}/address/${address}`;
}
