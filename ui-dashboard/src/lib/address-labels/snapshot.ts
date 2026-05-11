import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  importLabels,
  getLabels,
  mergeEntries,
  upgradeEntries,
  type AddressEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";
import {
  importReports,
  MAX_BODY_LENGTH as MAX_REPORT_BODY_LENGTH,
  MAX_TITLE_LENGTH as MAX_REPORT_TITLE_LENGTH,
  type AddressReport,
} from "@/lib/address-reports";
import { upgradeReport } from "@/lib/address-reports-shared";
import { isValidAddress } from "@/lib/format";
import { mergeWithExisting, sanitizeAndFilter } from "./import-helpers";

type SnapshotReportMetadataMode = "restamp" | "preserve";

/**
 * Snapshot import options.
 *
 * `reportMetadataMode: "restamp"` is for user-uploaded imports. The
 * authenticated user's email becomes the authoritative `authorEmail` on every
 * restored report, and timestamps/version are reset so a crafted upload cannot
 * forge another user's forensic trail.
 *
 * `reportMetadataMode: "preserve"` is for server-side restores from the
 * private Vercel Blob backup store. Those snapshots are produced by our cron,
 * so restores preserve report author/timestamp/version metadata verbatim.
 */
type SnapshotImportOptions = {
  /** Email of the authenticated user driving a user-uploaded import. */
  importerEmail: string;
  reportMetadataMode?: SnapshotReportMetadataMode;
  /** Sentry/log route tag for server errors. */
  errorTag?: string;
};

export async function handleSnapshot(
  body: AddressLabelsSnapshot,
  options: SnapshotImportOptions,
): Promise<NextResponse> {
  // Merge every entry from {addresses, global, chains} into a single
  // address-keyed map. Old backups carry `global` + `chains`; new backups
  // carry `addresses` (plus `global`/`chains` if the migration captured a
  // pre-existing flat hash alongside legacy scopes).
  //
  // When the same address appears in multiple sources, use `mergeEntries`
  // (union tags + updatedAt-newer-wins on scalars) instead of
  // `Object.assign`'s last-write-wins. Otherwise importing a backup that
  // captured both flat + legacy entries for the same address would silently
  // drop tags / notes / source from one of them.
  const merged: Record<string, AddressEntry> = {};
  function mergeIn(source: Record<string, AddressEntry>): void {
    for (const [addr, entry] of Object.entries(source)) {
      const lower = addr.toLowerCase();
      const prior = merged[lower];
      merged[lower] = prior ? mergeEntries(prior, entry) : entry;
    }
  }

  // Reject the mixed `{ labels, reports }` shape explicitly. The simple
  // format uses `labels` (not `addresses`), and `isSnapshot` now matches
  // anything with a `reports` key — so a legacy `{ labels, reports }`
  // payload routes here instead of to handleSimpleFormat. Without this
  // guard, the labels would be silently ignored (handleSnapshot only reads
  // `addresses`/`global`/`chains`) and the caller would see a 200 with
  // `imported.addresses = 0`. Surface the contradiction instead.
  if ((body as { labels?: unknown }).labels !== undefined) {
    return NextResponse.json(
      {
        error:
          "Snapshot must use `addresses` (not `labels`); a payload with both `labels` and `reports` is ambiguous — pick the simple format ({labels}) or the snapshot format ({addresses, reports}).",
      },
      { status: 400 },
    );
  }

  if (body.addresses !== undefined) {
    if (!isEntriesMap(body.addresses)) {
      return NextResponse.json(
        { error: "Invalid labels map for addresses" },
        { status: 400 },
      );
    }
    mergeIn(upgradeEntries(body.addresses as Record<string, unknown>));
  }
  if (body.global !== undefined) {
    if (!isEntriesMap(body.global)) {
      return NextResponse.json(
        { error: "Invalid labels map for legacy global scope" },
        { status: 400 },
      );
    }
    mergeIn(upgradeEntries(body.global as Record<string, unknown>));
  }
  if (body.chains !== undefined) {
    if (typeof body.chains !== "object" || body.chains === null) {
      return NextResponse.json(
        { error: "chains must be an object" },
        { status: 400 },
      );
    }
    for (const [key, labels] of Object.entries(body.chains)) {
      if (!isEntriesMap(labels)) {
        return NextResponse.json(
          { error: `Invalid labels map for legacy chain ${key}` },
          { status: 400 },
        );
      }
      mergeIn(upgradeEntries(labels as Record<string, unknown>));
    }
  }

  const reportsValidation = validateSnapshotReports(body.reports, {
    importerEmail: options.importerEmail,
    reportMetadataMode: options.reportMetadataMode ?? "restamp",
  });
  if ("error" in reportsValidation) {
    return NextResponse.json(
      { error: reportsValidation.error },
      { status: 400 },
    );
  }
  const reportsToImport: Record<string, AddressReport> =
    reportsValidation.reports;

  if (
    Object.keys(merged).length === 0 &&
    Object.keys(reportsToImport).length === 0
  ) {
    return NextResponse.json({ ok: true, imported: { addresses: 0 } });
  }

  try {
    let importedAddresses = 0;
    if (Object.keys(merged).length > 0) {
      let existing: Record<string, AddressEntry>;
      try {
        existing = await getLabels();
      } catch (err) {
        return serverError(err, options.errorTag);
      }
      const finalLabels = sanitizeAndFilter(
        mergeWithExisting(merged, existing),
      );
      await importLabels(finalLabels);
      importedAddresses = Object.keys(finalLabels).length;
    }
    if (Object.keys(reportsToImport).length > 0) {
      await importReports(reportsToImport);
    }
    return NextResponse.json({
      ok: true,
      imported: { addresses: importedAddresses },
    });
  } catch (err) {
    return serverError(err, options.errorTag);
  }
}

/**
 * Validate the `reports` half of a snapshot before restoring.
 *
 * Validates user-controlled fields (`body`, `title`) against the same
 * invariants the live editor enforces via `sanitizeReportInput`:
 * non-empty string body, body ≤ MAX_BODY_LENGTH, title ≤ MAX_TITLE_LENGTH.
 *
 * With `reportMetadataMode: "restamp"`, server-controlled fields
 * (`authorEmail`, `source`, `createdAt`, `updatedAt`, `version`) are NOT
 * trusted from the payload — they're re-stamped with the importer's email +
 * `"import"` source + `now()` + version 1.
 *
 * With `reportMetadataMode: "preserve"`, metadata is preserved after
 * normalisation. This mode is only for server-side restores from private
 * first-party Blob backups.
 */
export function validateSnapshotReports(
  raw: unknown,
  options: {
    importerEmail: string;
    reportMetadataMode?: SnapshotReportMetadataMode;
  },
): { reports: Record<string, AddressReport> } | { error: string } {
  if (raw === undefined) return { reports: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Invalid reports map" };
  }
  const mode = options.reportMetadataMode ?? "restamp";
  const now = new Date().toISOString();
  const result: Record<string, AddressReport> = {};
  for (const [addr, payload] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!isValidAddress(addr)) {
      return { error: `Invalid report address: ${addr}` };
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return { error: `Invalid report payload for ${addr}` };
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.body !== "string" || p.body.trim() === "") {
      return { error: `Report for ${addr} has an empty or non-string body` };
    }
    if (p.body.length > MAX_REPORT_BODY_LENGTH) {
      return {
        error: `Report for ${addr} body exceeds ${MAX_REPORT_BODY_LENGTH} characters`,
      };
    }
    let title: string | undefined;
    if (p.title !== undefined && p.title !== null) {
      if (typeof p.title !== "string") {
        return { error: `Report for ${addr} title is not a string` };
      }
      if (p.title.length > MAX_REPORT_TITLE_LENGTH) {
        return {
          error: `Report for ${addr} title exceeds ${MAX_REPORT_TITLE_LENGTH} characters`,
        };
      }
      // Match `sanitizeReportInput`: trim + drop if empty.
      const trimmed = p.title.trim();
      if (trimmed) title = trimmed;
    }

    if (mode === "preserve") {
      const restored = upgradeReport(p);
      result[addr.toLowerCase()] = {
        ...restored,
        body: p.body,
        ...(title ? { title } : {}),
      };
      continue;
    }

    // Re-stamp server-controlled metadata. Importer's email + `"import"`
    // source identifies the restore round; `version: 1` resets the monotonic
    // counter (any subsequent live edit will bump from 1 → 2).
    result[addr.toLowerCase()] = {
      body: p.body,
      ...(title ? { title } : {}),
      authorEmail: options.importerEmail,
      source: "import",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }
  return { reports: result };
}

export function isSnapshot(v: unknown): v is AddressLabelsSnapshot {
  if (typeof v !== "object" || v === null) return false;
  // A snapshot has at least one of `addresses`, `global`, `chains`, `reports`.
  const obj = v as Record<string, unknown>;
  return (
    "addresses" in obj || "global" in obj || "chains" in obj || "reports" in obj
  );
}

/**
 * Validates that a value is a map of address → entry objects.
 * Accepts both v1 (label field) and v2 (name field) entry shapes.
 * Entries where both name/label is empty and tags is empty are excluded.
 */
export function isEntriesMap(v: unknown): v is Record<string, AddressEntry> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([address, entry]) => {
      if (!isValidAddress(address)) return false;
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      // Accept v1 (label), v2 (name), or tag-only entries
      const hasName = typeof e.label === "string" || typeof e.name === "string";
      const hasTags = Array.isArray(e.tags) && e.tags.length > 0;
      return hasName || hasTags;
    },
  );
}

function serverError(err: unknown, routeTag = "address-labels/import") {
  // Full error is in Sentry; return a generic string to the client.
  Sentry.captureException(err, { tags: { route: routeTag } });
  console.error(`[${routeTag}]`, err);
  return NextResponse.json({ error: "Import failed" }, { status: 500 });
}
