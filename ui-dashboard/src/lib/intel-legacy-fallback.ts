import type { Redis } from "@upstash/redis";
import { getRedis } from "./redis";

// Upstash REST rejects a whole-hash read once the encoded reply exceeds
// ~10 MB (see MAX_REDIS_HASH_REPLACE_BYTES in ./redis-hash for the write-side
// analog). intel_deep already exceeds that cap on a plain HGETALL, so reads
// go through cursor-paginated HSCAN instead. 100 fields/page keeps each page
// well under the cap even at the largest observed field size (~50 KB).
export const HSCAN_PAGE_COUNT = 100;

// Safety bound: HSCAN's cursor contract guarantees eventual termination, but
// a client/server bug could in principle return a cursor that never comes
// back to "0". Bound the loop instead of hanging forever. 10,000 pages at
// 100 fields/page is 1,000,000 fields — far beyond any hash this code reads.
export const HSCAN_MAX_PAGES = 10_000;

type RedisHashReadClient = Pick<Redis, "hscan">;

/**
 * Read every field of one hash via cursor-paginated HSCAN, so no single
 * round-trip has to carry the whole hash (see module comment). HSCAN may
 * return a field more than once across pages when the hash is mutated
 * mid-scan; later pages are applied last, so the last-seen value for a
 * field wins.
 *
 * The @upstash/redis SDK JSON-decodes each HSCAN reply element the same way
 * it decodes HGETALL values (both route through the SDK's shared recursive
 * parser), so a value normally arrives already as `T`, not a raw string.
 * Re-parse defensively when a value does come back as a string, mirroring
 * HGETALL's own per-value fallback, so behavior does not depend on that SDK
 * internal.
 */
async function hscanAll<T>(
  redis: RedisHashReadClient,
  key: string,
): Promise<Record<string, T>> {
  const merged: Record<string, T> = {};
  let cursor: string | number = 0;
  let pages = 0;
  do {
    // Sequential by necessity: each page's cursor comes from the previous
    // page's reply, so pages cannot be requested concurrently.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const [nextCursor, flat] = await redis.hscan(key, cursor, {
      count: HSCAN_PAGE_COUNT,
    });
    for (let i = 0; i < flat.length; i += 2) {
      const field = String(flat[i]);
      merged[field] = coerceHScanValue<T>(flat[i + 1]);
    }
    // Normalize defensively: the SDK's declared return type is `string`,
    // but nothing here should rely on that never slipping — the .mjs
    // HSCAN helpers normalize the same way, and a stray numeric cursor
    // (e.g. terminal `0`) must still satisfy the `"0"` check below rather
    // than looping until the page-count bound trips.
    cursor = String(nextCursor);
    pages += 1;
    // Check before requesting another page, not after: a scan that
    // completes exactly at the bound (cursor "0" on page HSCAN_MAX_PAGES)
    // must succeed, and a scan that still isn't done at the bound must
    // throw here instead of first fetching page HSCAN_MAX_PAGES + 1.
    if (cursor !== "0" && pages >= HSCAN_MAX_PAGES) {
      throw new Error(
        `HSCAN on "${key}" did not terminate within ${HSCAN_MAX_PAGES} pages; aborting instead of looping forever.`,
      );
    }
  } while (cursor !== "0");
  return merged;
}

function coerceHScanValue<T>(raw: string | number | undefined): T {
  if (typeof raw !== "string") return raw as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

/**
 * Read a single hash field, preferring the intel hash and falling back to the
 * legacy arkham hash if the field is missing. Covers the deploy → migrate
 * window where prod data may still live under the legacy hash name.
 *
 * Intel-hash writes are normalized to lowercase (round-5 marathon fix), so a
 * single lowercase probe is sufficient there. Legacy arkham_* hashes may have
 * mixed-case address keys (pre-normalization marathon writes), so we probe
 * lowercase first and fall back to the caller's original casing if the
 * lowercase miss could be that case-mismatch.
 *
 * Entity-slug callers are unaffected because INTEL_ENTITY_SLUG_RE enforces
 * lowercase by spec; the original-case fallback is a no-op when field is
 * already all-lowercase.
 */
export async function hgetWithLegacy<T>(
  intelKey: string,
  legacyKey: string,
  field: string,
): Promise<T | null> {
  const redis = getRedis();
  const lower = field.toLowerCase();
  const fromIntel = await redis.hget<T>(intelKey, lower);
  if (fromIntel !== null && fromIntel !== undefined) return fromIntel;
  const fromLegacyLower = await redis.hget<T>(legacyKey, lower);
  if (fromLegacyLower !== null && fromLegacyLower !== undefined) {
    return fromLegacyLower;
  }
  // Mixed-case legacy fallback: only re-probe when the caller's original
  // casing differs (avoids a redundant round-trip for the common lowercase
  // case).
  if (lower === field) return null;
  return redis.hget<T>(legacyKey, field);
}

/**
 * Read every entry across the intel + legacy arkham hashes; intel keys win on
 * collision. All keys are canonicalized to lowercase so mixed-case legacy
 * entries don't leak through to the dashboard's lowercase-keyed reads (and
 * don't survive into snapshots/restore as effectively-orphan rows).
 *
 * Returns `{}` when both hashes are absent.
 */
export async function hgetallWithLegacy<T>(
  intelKey: string,
  legacyKey: string,
): Promise<Record<string, T>> {
  const redis = getRedis();
  const [fromIntel, fromLegacy] = await Promise.all([
    hscanAll<T>(redis, intelKey),
    hscanAll<T>(redis, legacyKey),
  ]);
  const merged: Record<string, T> = {};
  for (const [k, v] of Object.entries(fromLegacy)) merged[k.toLowerCase()] = v;
  // Intel overwrites legacy on collision (intel is the canonical post-deploy
  // writer). Intel keys are already lowercase by spec, so toLowerCase() is a
  // defensive no-op.
  for (const [k, v] of Object.entries(fromIntel)) merged[k.toLowerCase()] = v;
  return merged;
}
