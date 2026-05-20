import { getRedis } from "./redis";

/**
 * Read a single hash field, preferring the intel hash and falling back to the
 * legacy arkham hash if the field is missing. Covers the deploy → migrate
 * window where prod data may still live under the legacy hash name.
 *
 * The field name is lower-cased before each lookup: address callers already
 * pass `address.toLowerCase()`, but legacy arkham_* hashes may have been
 * written with checksum/mixed-case keys before the round-5 marathon fix
 * normalized writes. Entity slugs are spec-lowercase (`INTEL_ENTITY_SLUG_RE`),
 * so this is a no-op for them.
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
  return redis.hget<T>(legacyKey, lower);
}

/**
 * Read every entry across the intel + legacy arkham hashes; intel keys win on
 * collision. Returns `{}` when both hashes are absent.
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
  return { ...(fromLegacy ?? {}), ...(fromIntel ?? {}) };
}

/**
 * Union of field names across intel + legacy arkham hashes. Used by paginated
 * directory listings (e.g. `/entities`) so legacy data stays browsable until
 * the rename migration runs.
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
  return Array.from(new Set([...fromIntel, ...fromLegacy]));
}
