/**
 * Isomorphic address-labels utilities — no server dependencies (Redis, etc).
 * Safe to import from client components, providers, and server code alike.
 */

import type { AddressReport } from "./address-reports-shared";

// Types

export type AddressEntry = {
  name: string;
  tags: string[];
  notes?: string;
  isPublic?: boolean;
  /**
   * Provenance marker. Set by server-side enrichment pipelines
   * (currently `"arkham"`); omitted for user-curated entries. User-controlled
   * input paths (PUT, import) MUST strip this field — see route handlers.
   */
  source?: string;
  /**
   * ISO timestamp of first write. Set by `upsertEntry` when no prior entry
   * exists; preserved across edits and refreshes. Optional because pre-
   * migration entries didn't carry it — readers fall back to `updatedAt`.
   */
  createdAt?: string;
  updatedAt: string;
};

/** Full record as returned from the API -- includes the address itself. */
export type AddressEntryRecord = AddressEntry & {
  address: string;
};

/** Shape of a full export/backup snapshot.
 *
 * The `chains` field is retained as an OPTIONAL READ for backward compat
 * with older snapshots that predate the global-only refactor — old backups
 * with `labels:{chainId}` entries can still be imported. New writes always
 * produce `addresses` only.
 *
 * `reports` is the forensic-report payload (markdown bodies up to 50KB
 * each, keyed by lowercase address). Optional so older snapshots that
 * predate the parity backfill still parse without error. The daily backup
 * cron emits both `addresses` and `reports` so a Redis flush has a single
 * snapshot to restore from. */
export type AddressLabelsSnapshot = {
  exportedAt: string;
  /** Flat per-address entries — current shape. */
  addresses?: Record<string, AddressEntry>;
  /** Legacy: cross-chain entries from pre-flat snapshots. Read-only. */
  global?: Record<string, AddressEntry>;
  /** Legacy: chainId → address → entry. Read-only; merged into addresses on import. */
  chains?: Record<string, Record<string, AddressEntry>>;
  /** Forensic reports keyed by lowercase address. Optional for back-compat
   * with snapshots predating PR #339; new daily backups always include it
   * (possibly as an empty record when no reports exist yet). */
  reports?: Record<string, AddressReport>;
};

/** Tally of newly-imported labels returned by the import API. */
export type ImportedCounts = {
  addresses: number;
  reports?: number;
};

/**
 * Legacy provenance tag. Pre-source-field entries persisted `"arkham"`
 * inside `tags`. New writes carry provenance in `AddressEntry.source`
 * instead and exclude the tag entirely; this constant is retained so
 * `isArkhamSourced` still recognises pre-migration entries until they get
 * re-enriched.
 */
export const ARKHAM_TAG = "arkham";

/** Provenance marker for the MiniPay tagging cron. */
export const MINIPAY_SOURCE = "minipay";

function isReservedArkhamTag(tag: string): boolean {
  return tag.trim().toLowerCase() === ARKHAM_TAG;
}

export function withoutArkhamTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isReservedArkhamTag(tag));
}

function hasLegacyArkhamSentinel(tags: readonly string[] | undefined): boolean {
  return tags?.includes(ARKHAM_TAG) === true;
}

/**
 * True when an existing entry was written by the Arkham enrichment cron.
 * Accepts both the new shape (`source === "arkham"`) and legacy entries
 * predating the source field (`tags` includes the exact sentinel). Non-exact
 * display tags such as "Arkham" remain manual labels.
 */
export function isArkhamSourced(entry: {
  source?: string;
  tags?: string[];
}): boolean {
  return entry.source === "arkham" || hasLegacyArkhamSentinel(entry.tags);
}

/** True when an existing entry was written by the MiniPay tagging cron. */
export function isMiniPaySourced(entry: { source?: string }): boolean {
  return entry.source === MINIPAY_SOURCE;
}

/**
 * Map a prior entry (or its absence) to the `source` field that should be
 * carried into a write. User edits MUST NOT silently demote a server-tagged
 * entry to `custom` — that would drop it out of future refresh runs and
 * lose entity attribution. Returns `undefined` for fresh writes and for
 * priors that never had a server provenance.
 */
export function derivePreservedSource(
  prior: { source?: string; tags?: string[] } | null | undefined,
): "arkham" | "minipay" | undefined {
  if (!prior) return undefined;
  if (isArkhamSourced(prior)) return "arkham";
  if (isMiniPaySourced(prior)) return "minipay";
  return undefined;
}

/**
 * Merge a prior entry with an incoming one. Resolution: union tags
 * (case-insensitive dedup), prefer the more recently updated entry's
 * scalar fields, take the earliest createdAt. Ties on `updatedAt` resolve
 * in favour of `incoming`.
 *
 * `name` is taken from `newer` directly — empty-name tag-only entries are
 * meaningful, so a truthiness fallback (`newer.name || older.name`) would
 * resurrect a stale older name when the newer write intentionally cleared
 * it.
 *
 * Used by:
 *   - the snapshot import path, when a backup contains the same address in
 *     `addresses` + `global` + `chains` (including old conflicted backups
 *     produced before the flat-label migration was retired)
 */
export function mergeEntries(
  prior: AddressEntry,
  incoming: AddressEntry,
): AddressEntry {
  const incomingLater = (incoming.updatedAt ?? "") >= (prior.updatedAt ?? "");
  const newer = incomingLater ? incoming : prior;
  const older = incomingLater ? prior : incoming;

  const tagSet = new Map<string, string>();
  for (const t of [...older.tags, ...newer.tags]) {
    const key = t.toLowerCase();
    if (!tagSet.has(key)) tagSet.set(key, t);
  }

  const createdCandidates = [prior.createdAt, incoming.createdAt].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  // Single-pass min — string lex-order works because both candidates are
  // ISO-8601 timestamps when present (chars compare in chronological order).
  const createdAt = createdCandidates.reduce<string | undefined>(
    (min, next) => (min === undefined || next < min ? next : min),
    undefined,
  );

  return {
    name: newer.name,
    tags: Array.from(tagSet.values()),
    notes: newer.notes ?? older.notes,
    isPublic: newer.isPublic ?? older.isPublic,
    source: newer.source ?? older.source,
    ...(createdAt ? { createdAt } : {}),
    updatedAt: newer.updatedAt,
  };
}

/**
 * Normalise a legacy-shaped entry (`tags` carries the exact `ARKHAM_TAG`
 * sentinel, no `source` field) into the new shape (`source: "arkham"`,
 * reserved sentinel variants removed from tags). New-shape entries pass
 * through untouched.
 *
 * Apply this at READ-direction UI boundaries so editor pre-fill, autocomplete
 * suggestions, and the table all see the same clean tag list. Do NOT apply
 * at server-side import paths — that would auto-promote a user-imported
 * `tags: ["arkham"]` to Arkham-sourced (see `stripArkhamProvenance` instead).
 */
export function normalizeArkhamLegacy(entry: AddressEntry): AddressEntry {
  if (entry.source === "arkham" || !hasLegacyArkhamSentinel(entry.tags)) {
    return entry;
  }
  return {
    ...entry,
    source: "arkham",
    tags: withoutArkhamTags(entry.tags),
  };
}

// Backward-compat: auto-upgrade legacy entries on read

/**
 * If a Redis entry has `label` but no `name`, auto-upgrade to the new schema.
 * This handles both partially-migrated Redis data and stale SWR cache entries.
 *
 * Pre-migration entries don't carry an `updatedAt` — we substitute the empty
 * string `""` (rather than `new Date().toISOString()`) so the value is stable
 * across SWR polls. The detail page keys the form mount on `entry.updatedAt`,
 * so a fresh timestamp on every fetch would discard in-progress edits every
 * 30 s for legacy rows. The merge logic in `mergeEntries` already handles
 * empty `updatedAt` via `?? ""`, so ordering semantics are preserved (any
 * persisted timestamp sorts after `""`, which is the right "newer wins"
 * behaviour for a save that adds the timestamp).
 */
export function upgradeEntry(raw: Record<string, unknown>): AddressEntry {
  const entry = raw as Record<string, unknown>;

  const normalizedTags = Array.isArray(entry.tags)
    ? entry.tags.filter((t): t is string => typeof t === "string")
    : [];

  const source =
    typeof entry.source === "string" && entry.source ? entry.source : undefined;
  const createdAt =
    typeof entry.createdAt === "string" && entry.createdAt
      ? entry.createdAt
      : undefined;

  // Already in v2 format — unless the name is blank and we can recover a
  // valid legacy label from mixed/partially-corrupted data.
  if (
    typeof entry.name === "string" &&
    (entry.name.trim() || typeof entry.label !== "string")
  ) {
    return {
      name: entry.name,
      tags: normalizedTags,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
      isPublic: entry.isPublic === true ? true : undefined,
      ...(source ? { source } : {}),
      ...(createdAt ? { createdAt } : {}),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    };
  }

  // Legacy v1 format: { label, category?, ... }
  if (typeof entry.label === "string") {
    const tags = normalizedTags.length > 0 ? normalizedTags : [];
    if (
      tags.length === 0 &&
      typeof entry.category === "string" &&
      entry.category.trim()
    ) {
      tags.push(entry.category.trim());
    }
    return {
      name: entry.label,
      tags,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
      isPublic: entry.isPublic === true ? true : undefined,
      ...(source ? { source } : {}),
      ...(createdAt ? { createdAt } : {}),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    };
  }

  // Fallback: no name/label — preserve any tags so tag-only entries
  // (the third shape `isEntriesMap` accepts) survive the upgrade pipeline
  // instead of getting silently dropped by the downstream `name !== "" ||
  // tags.length > 0` filter in `sanitizeAndFilter`.
  return {
    name: "",
    tags: normalizedTags,
    notes: typeof entry.notes === "string" ? entry.notes : undefined,
    isPublic: entry.isPublic === true ? true : undefined,
    ...(source ? { source } : {}),
    ...(createdAt ? { createdAt } : {}),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
  };
}

export function upgradeEntries(
  raw: Record<string, unknown>,
): Record<string, AddressEntry> {
  const result: Record<string, AddressEntry> = {};
  for (const [address, entry] of Object.entries(raw)) {
    if (typeof entry === "object" && entry !== null) {
      result[address] = upgradeEntry(entry as Record<string, unknown>);
    }
  }
  return result;
}

// Entry sanitization — shared limits for PUT + import paths

const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 500;
const MAX_TAGS_COUNT = 20;
const MAX_TAG_LENGTH = 50;

/**
 * Sanitize an AddressEntry: truncate name/notes, cap tag count/length,
 * trim + case-insensitive dedup tags.
 */
export function sanitizeEntry(entry: AddressEntry): AddressEntry {
  const name = entry.name.trim().slice(0, MAX_NAME_LENGTH);
  const notes = entry.notes?.slice(0, MAX_NOTES_LENGTH);

  // Trim, truncate, and case-insensitive dedup tags — single pass.
  const seenTags = new Set<string>();
  const tags = entry.tags.slice(0, MAX_TAGS_COUNT).flatMap((raw) => {
    const t = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!t) return [];
    const key = t.toLowerCase();
    if (seenTags.has(key)) return [];
    seenTags.add(key);
    return [t];
  });

  return {
    ...entry,
    name,
    tags,
    ...(notes !== undefined ? { notes } : {}),
  };
}
