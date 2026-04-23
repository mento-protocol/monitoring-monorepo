// `42220-0xabc` → `0xabc`. Input returned unchanged if no dash.
export function poolIdAddress(poolId: string): string {
  const dash = poolId.indexOf("-");
  return dash >= 0 ? poolId.slice(dash + 1) : poolId;
}

// `0x93e15a22…ead61` → `0x93e1…ad61`. Keeps 4 leading + 4 trailing nibbles
// so both ends stay distinguishable in Slack without eating 40+ chars.
export function shortAddress(address: string): string {
  if (!address.startsWith("0x") || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
