/**
 * Wormholescan's `/tx/<id>` route resolves against SOURCE-chain transaction
 * hashes (and VAA IDs), NOT against raw NTT digests. Passing a digest here
 * returns an empty operations response and renders an empty page. This helper
 * is only useful when we have the source-chain tx hash.
 *
 * Verified via `api.wormholescan.io/api/v1/operations?txHash=…`:
 *   - source tx hash → full operation payload
 *   - digest         → { operations: [] }
 *   - dest tx hash   → { operations: [] }
 */
export function wormholescanUrl(sourceTxHash: string): string {
  return `https://wormholescan.io/#/tx/${sourceTxHash}`;
}
