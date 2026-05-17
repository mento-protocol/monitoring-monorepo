import {
  ARKHAM_TAG,
  sanitizeEntry,
  type AddressEntry,
} from "@/lib/address-labels-shared";

/**
 * User-controlled imports must never claim Arkham provenance — neither via
 * the new `source` field nor via the legacy `ARKHAM_TAG` tag sentinel that
 * `isArkhamSourced` still honours for backward compat. Without stripping
 * the tag, an authenticated user could import `tags: ["arkham"]` and have
 * the next refresh cron clobber their entry as a re-enrichment target.
 *
 * Re-importing an Arkham-enriched backup snapshot also resets provenance —
 * only the enrichment cron is allowed to set `source: "arkham"`.
 */
export function stripArkhamProvenance(entry: AddressEntry): AddressEntry {
  return {
    ...entry,
    source: undefined,
    tags: entry.tags.filter((t) => t.trim().toLowerCase() !== ARKHAM_TAG),
  };
}

/**
 * Merge an import batch against the existing labels map so an address keeps
 * its prior `notes` + `isPublic` unless the import explicitly overwrites
 * them.
 *
 * Plain `{...prev, ...entry}` is broken here: `upgradeEntry` materialises
 * `notes: undefined` and `isPublic: undefined` for fields the import doesn't
 * set, which then clobber prev's real values during the spread (a present-
 * undefined key beats prev's "carry me"). Drop undefined keys from incoming
 * before the spread so prev's values survive.
 */
export function mergeWithExisting(
  incoming: Record<string, AddressEntry>,
  existing: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  const out: Record<string, AddressEntry> = {};
  for (const [addr, entry] of Object.entries(incoming)) {
    const prev = existing[addr.toLowerCase()];
    if (!prev) {
      out[addr] = stripArkhamProvenance(entry);
      continue;
    }
    const incomingDefined: Partial<AddressEntry> = {};
    for (const [k, v] of Object.entries(entry) as Array<
      [keyof AddressEntry, unknown]
    >) {
      if (v !== undefined) {
        (incomingDefined as Record<string, unknown>)[k] = v;
      }
    }
    out[addr] = stripArkhamProvenance({
      ...prev,
      ...incomingDefined,
      // The import's tags are authoritative when the format supports tags;
      // otherwise (simple + snapshot) incoming `entry.tags` already reflects
      // the caller's intent (they may be empty).
      tags: entry.tags,
    } as AddressEntry);
  }
  return out;
}

// Sanitize (enforce limits) + filter empty entries. Lower-cases addresses so
// downstream writes are canonical.
export function sanitizeAndFilter(
  entries: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([addr, e]) => {
      const sanitized = sanitizeEntry(e);
      if (sanitized.name === "" && sanitized.tags.length === 0) return [];
      return [[addr.toLowerCase(), sanitized] as const];
    }),
  );
}
