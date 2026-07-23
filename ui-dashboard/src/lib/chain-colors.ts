// Brand colors picked from celo.org / monad.xyz. Add new chains here.
const CHAIN_COLORS: Record<number, string> = {
  42220: "#FCFF51", // Celo
  11142220: "#FCFF51",
  143: "#6E54FF", // Monad
  137: "#8247E5", // Polygon
  80002: "#8247E5",
};

export function chainColor(chainId: number): string {
  return CHAIN_COLORS[chainId] ?? "#94a3b8";
}
