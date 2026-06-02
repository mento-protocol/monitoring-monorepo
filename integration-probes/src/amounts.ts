export function decimalAmountToRaw(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `Amount ${amount} has more fractional digits than token decimals ${decimals}`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  const raw = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return raw === "" ? "0" : raw;
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function addressFromPoolId(poolId: string): string {
  const dash = poolId.indexOf("-");
  return dash >= 0
    ? poolId.slice(dash + 1).toLowerCase()
    : poolId.toLowerCase();
}

export function isoDay(iso: string): string {
  return iso.slice(0, 10);
}
