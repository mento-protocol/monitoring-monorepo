/**
 * Same-tx scratch-pairing helper shared by source-side (TransferSentDetailed
 * → TransferSentDigest) and destination-side (ReceivedMessage →
 * MessageAttestedTo / TransferRedeemed) paths.
 *
 * Both directions write a scratch entity keyed by
 * `{chainId}-{txHash}-{logIndex}` from the earlier-in-tx event; the later
 * event walks backward through logIndex to find it. The source-side scratch
 * is `WormholeTransferPending`, the destination-side scratch is
 * `WormholeDestPending` — different payloads, same key scheme, same walk.
 */

/** Upper bound on how far back we scan before giving up. NTT-typical spacing
 * between the earlier and later event in the same tx is ≤50 logs on Monad;
 * 256 keeps ~5× headroom without turning the walk into an unbounded probe. */
export const MAX_PAIRING_BACKWALK = 256;

export type PairingKey = {
  chainId: number;
  txHash: string;
  currentLogIndex: number;
};

export type PairingEntityAccessor<T> = {
  get: (id: string) => Promise<T | undefined>;
  deleteUnsafe?: (id: string) => void;
};

/**
 * Walk backward from `currentLogIndex - 1` down through up to
 * `MAX_PAIRING_BACKWALK` offsets looking for a scratch row written by an
 * earlier event in this same transaction. Returns `{ row, id }` on hit (with
 * the matching row AND its key so the caller can delete it), or
 * `{ row: undefined, id: "" }` on miss. The caller decides whether to delete.
 *
 * Note: callers MAY want to apply an identity check (e.g. match a dest
 * transceiver address) before claiming the scratch, to guard against
 * multi-transceiver or multi-send flows where multiple scratch rows from
 * distinct logical pairs live in the same tx. Pass `matches` to filter.
 */
export async function findPendingScratch<T>(
  entity: PairingEntityAccessor<T>,
  { chainId, txHash, currentLogIndex }: PairingKey,
  matches?: (row: T) => boolean,
): Promise<{ row: T | undefined; id: string }> {
  const txHashLower = txHash.toLowerCase();
  const maxOffset = Math.min(currentLogIndex, MAX_PAIRING_BACKWALK);
  for (let offset = 1; offset <= maxOffset; offset++) {
    const candidateId = `${chainId}-${txHashLower}-${currentLogIndex - offset}`;
    const row = await entity.get(candidateId);
    if (!row) continue;
    if (matches && !matches(row)) continue;
    return { row, id: candidateId };
  }
  return { row: undefined, id: "" };
}

/**
 * Shortcut over `findPendingScratch` that deletes the row on hit. Returns the
 * row payload (or undefined). Most callers want this — they want the payload
 * AND want the scratch reaped so it doesn't leak as ghost rows.
 */
export async function findAndDrainPendingScratch<T>(
  entity: PairingEntityAccessor<T>,
  key: PairingKey,
  matches?: (row: T) => boolean,
): Promise<T | undefined> {
  const { row, id } = await findPendingScratch(entity, key, matches);
  if (row && id) entity.deleteUnsafe?.(id);
  return row;
}
