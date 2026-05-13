/**
 * Isomorphic address-reports utilities — no server dependencies (Redis, etc).
 * Safe to import from client components, providers, and server code alike.
 *
 * Forensic reports are deep investigations attached to an address — markdown
 * bodies up to 50KB. Distinct from the 500-char `notes` field on AddressEntry,
 * which stays optimised for short recognition labels.
 *
 * Reports are address-keyed only — there is no chain/global scope. Same EVM
 * address → same entity (same private key derives the same address across
 * every chain), so a single report applies wherever the address appears.
 * The earlier per-scope storage caused recurring scope-mismatch bugs that
 * the model itself doesn't justify; rolled back to address-only on PR #330.
 */

type AddressReportSource = "manual" | "claude" | "Codex" | "import";

export type AddressReport = {
  /** Markdown body of the report. Capped at MAX_BODY_LENGTH characters. */
  body: string;
  /** Optional short title shown above the body. Capped at MAX_TITLE_LENGTH. */
  title?: string;
  /**
   * Email of the workspace user who last edited the report. Server-set from
   * the NextAuth session — never accepted from request bodies.
   */
  authorEmail?: string;
  /**
   * Provenance: 'manual' = typed in editor, 'claude' / 'Codex' = generated,
   * 'import' = bulk import. Optional; absent for legacy entries.
   */
  source?: AddressReportSource;
  /** ISO timestamp of first write. Preserved across edits. */
  createdAt: string;
  /** ISO timestamp of most recent write. */
  updatedAt: string;
  /** Monotonic version counter, incremented on each write. Starts at 1. */
  version: number;
};

/**
 * Index of addresses that have a report — just the lowercase address list.
 * The 📄 indicator only needs existence; the editor fetches the full
 * report on open by address, which is where title / version / authorEmail /
 * updatedAt come from.
 */
export type AddressReportsIndex = {
  /** Lowercase 0x addresses with a report. */
  addresses: string[];
};

// Limits — 50KB per body (50,000 characters).
export const MAX_BODY_LENGTH = 50_000;
export const MAX_TITLE_LENGTH = 200;

export type SanitizeReportResult =
  | { ok: true; body: string; title?: string }
  | { ok: false; error: string };

/**
 * Sanitize a report payload coming from a request body.
 * - body: required string, trimmed-empty rejected, hard-capped at MAX_BODY_LENGTH
 * - title: optional string, trimmed; dropped if empty; capped at MAX_TITLE_LENGTH
 *
 * Server-controlled fields (authorEmail, createdAt, updatedAt, version, source)
 * MUST be set by the route handler — never trust request bodies for those.
 */
export function sanitizeReportInput(input: {
  body: unknown;
  title?: unknown;
}): SanitizeReportResult {
  if (typeof input.body !== "string") {
    return { ok: false, error: "body must be a string" };
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      error: `body must be ${MAX_BODY_LENGTH} characters or fewer`,
    };
  }
  if (input.body.trim() === "") {
    return { ok: false, error: "body must be non-empty" };
  }
  let title: string | undefined;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== "string") {
      return { ok: false, error: "title must be a string when provided" };
    }
    const trimmed = input.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (trimmed) title = trimmed;
  }
  return title !== undefined
    ? { ok: true, body: input.body, title }
    : { ok: true, body: input.body };
}

/**
 * Normalise a stored report read from Redis — tolerates partial/legacy shapes.
 * Defaults missing version to 1, missing timestamps to now.
 */
export function upgradeReport(raw: Record<string, unknown>): AddressReport {
  const body = typeof raw.body === "string" ? raw.body : "";
  const title =
    typeof raw.title === "string" && raw.title ? raw.title : undefined;
  const authorEmail =
    typeof raw.authorEmail === "string" && raw.authorEmail
      ? raw.authorEmail
      : undefined;
  const source =
    raw.source === "manual" ||
    raw.source === "claude" ||
    raw.source === "Codex" ||
    raw.source === "import"
      ? raw.source
      : undefined;
  const createdAt =
    typeof raw.createdAt === "string" && raw.createdAt
      ? raw.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt
      ? raw.updatedAt
      : createdAt;
  const version =
    typeof raw.version === "number" && raw.version > 0
      ? Math.floor(raw.version)
      : 1;

  return {
    body,
    ...(title ? { title } : {}),
    ...(authorEmail ? { authorEmail } : {}),
    ...(source ? { source } : {}),
    createdAt,
    updatedAt,
    version,
  };
}

export function upgradeReports(
  raw: Record<string, unknown>,
): Record<string, AddressReport> {
  const result: Record<string, AddressReport> = {};
  for (const [addr, r] of Object.entries(raw)) {
    if (typeof r === "object" && r !== null) {
      result[addr] = upgradeReport(r as Record<string, unknown>);
    }
  }
  return result;
}
