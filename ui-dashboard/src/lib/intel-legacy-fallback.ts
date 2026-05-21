import { getRedis } from "./redis";

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
    redis.hgetall<Record<string, T>>(intelKey),
    redis.hgetall<Record<string, T>>(legacyKey),
  ]);
  const merged: Record<string, T> = {};
  if (fromLegacy) {
    for (const [k, v] of Object.entries(fromLegacy))
      merged[k.toLowerCase()] = v;
  }
  // Intel overwrites legacy on collision (intel is the canonical post-deploy
  // writer). Intel keys are already lowercase by spec, so toLowerCase() is a
  // defensive no-op.
  if (fromIntel) {
    for (const [k, v] of Object.entries(fromIntel)) merged[k.toLowerCase()] = v;
  }
  return merged;
}

/**
 * Union of field names across intel + legacy arkham hashes, normalized to
 * lowercase. Used by paginated directory listings (e.g. `/entities`) so
 * legacy data stays browsable until the rename migration runs.
 */
export async function hkeysWithLegacy(
  intelKey: string,
  legacyKey: string,
): Promise<string[]> {
  const redis = getRedis();
  const [fromIntel, fromLegacy] = await Promise.all([
    redis.hkeys(intelKey),
    redis.hkeys(legacyKey),
  ]);
  return Array.from(
    new Set([
      ...fromIntel.map((k) => k.toLowerCase()),
      ...fromLegacy.map((k) => k.toLowerCase()),
    ]),
  );
}
