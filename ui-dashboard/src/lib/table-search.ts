/**
 * Shared helpers for client-side table search/filtering.
 *
 * Each table builds a "search blob" per row — a single lowercased string
 * containing all searchable content (raw addresses, resolved labels,
 * formatted numbers, tx hashes, status text, etc.).  The query is matched
 * as a case-insensitive substring against that blob.
 */

/** Normalize a user-entered search query for comparison. */
export function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Build a single searchable string from an array of terms.
 *
 * Null / undefined / empty entries are silently dropped.  Each remaining
 * entry is lowercased and joined with newlines so that a simple
 * `.includes(query)` gives substring matching across all terms.
 */
export function buildSearchBlob(
  parts: Array<string | number | null | undefined>,
): string {
  return parts
    .flatMap((part) => {
      if (part === null || part === undefined) return [];
      const s = String(part).trim();
      return s ? [s.toLowerCase()] : [];
    })
    .join("\n");
}

/**
 * Check whether a pre-built search blob matches a normalized query.
 * Returns `true` when query is empty (show all rows).
 */
export function matchesSearch(blob: string, query: string): boolean {
  if (!query) return true;
  return blob.includes(query);
}
