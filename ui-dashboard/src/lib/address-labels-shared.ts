/**
 * Isomorphic address-labels utilities — no server dependencies (Redis, etc).
 * Safe to import from client components, providers, and server code alike.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddressEntry = {
  name: string;
  tags: string[];
  notes?: string;
  isPublic?: boolean;
  updatedAt: string;
};

/** @deprecated Use AddressEntry instead */
export type AddressLabelEntry = AddressEntry;

/** Full record as returned from the API -- includes the address itself. */
export type AddressEntryRecord = AddressEntry & {
  address: string;
};

/** @deprecated Use AddressEntryRecord instead */
export type AddressLabelRecord = AddressEntryRecord;

/** Shape of a full export/backup snapshot. */
export type AddressLabelsSnapshot = {
  exportedAt: string;
  /** chainId → address (lower) → entry */
  chains: Record<string, Record<string, AddressEntry>>;
};

// ---------------------------------------------------------------------------
// Backward-compat: auto-upgrade legacy entries on read
// ---------------------------------------------------------------------------

/**
 * If a Redis entry has `label` but no `name`, auto-upgrade to the new schema.
 * This handles both partially-migrated Redis data and stale SWR cache entries.
 */
export function upgradeEntry(raw: Record<string, unknown>): AddressEntry {
  const entry = raw as Record<string, unknown>;

  const normalizedTags = Array.isArray(entry.tags)
    ? entry.tags.filter((t): t is string => typeof t === "string")
    : [];

  // Already in v2 format — unless the name is blank and we can recover a
  // valid legacy label from mixed/partially-corrupted data.
  if (typeof entry.name === "string") {
    if (entry.name.trim() || typeof entry.label !== "string") {
      return {
        name: entry.name,
        tags: normalizedTags,
        notes: typeof entry.notes === "string" ? entry.notes : undefined,
        isPublic: entry.isPublic === true ? true : undefined,
        updatedAt:
          typeof entry.updatedAt === "string"
            ? entry.updatedAt
            : new Date().toISOString(),
      };
    }
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
      updatedAt:
        typeof entry.updatedAt === "string"
          ? entry.updatedAt
          : new Date().toISOString(),
    };
  }

  // Fallback: unknown shape — return minimal valid entry
  return {
    name: "",
    tags: [],
    notes: typeof entry.notes === "string" ? entry.notes : undefined,
    isPublic: entry.isPublic === true ? true : undefined,
    updatedAt:
      typeof entry.updatedAt === "string"
        ? entry.updatedAt
        : new Date().toISOString(),
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

// ---------------------------------------------------------------------------
// Entry sanitization — shared limits for PUT + import paths
// ---------------------------------------------------------------------------

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

  // Trim, truncate, and case-insensitive dedup tags
  const seenTags = new Set<string>();
  const tags = entry.tags
    .slice(0, MAX_TAGS_COUNT)
    .map((t) => t.trim().slice(0, MAX_TAG_LENGTH))
    .filter((t) => {
      if (!t) return false;
      const key = t.toLowerCase();
      if (seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    });

  return {
    ...entry,
    name,
    tags,
    ...(notes !== undefined ? { notes } : {}),
  };
}
