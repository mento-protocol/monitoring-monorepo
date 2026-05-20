import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  getLabels,
  mergeEntries,
  upgradeEntries,
  type AddressEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";
import {
  MAX_BODY_LENGTH as MAX_REPORT_BODY_LENGTH,
  MAX_TITLE_LENGTH as MAX_REPORT_TITLE_LENGTH,
  type AddressReport,
} from "@/lib/address-reports";
import { upgradeReport } from "@/lib/address-reports-shared";
import { isValidAddress } from "@/lib/format";
import {
  importSnapshotHashes,
  replaceSnapshotHashes,
} from "@/lib/address-label-restore-writes";
import { mergeWithExisting, sanitizeAndFilter } from "./import-helpers";

type SnapshotReportMetadataMode = "restamp" | "preserve";
type SnapshotLabelProvenanceMode = "strip" | "preserve";
type SnapshotWriteMode = "merge" | "replace";

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
 *
 * `labelProvenanceMode: "preserve"` and `writeMode: "replace"` are also
 * reserved for those trusted restores. User-uploaded imports keep stripping
 * server-owned label provenance and merge into the existing Redis hashes.
 */
type SnapshotImportOptions = {
  /** Email of the authenticated user driving a user-uploaded import. */
  importerEmail: string;
  reportMetadataMode?: SnapshotReportMetadataMode;
  labelProvenanceMode?: SnapshotLabelProvenanceMode;
  writeMode?: SnapshotWriteMode;
  /** Sentry/log route tag for server errors. */
  errorTag?: string;
};

type LabelParseResult =
  | { merged: Record<string, AddressEntry>; hasLabelPayload: boolean }
  | { error: string };

/**
 * Merge every entry from {addresses, global, chains} into a single
 * address-keyed map. Old backups carry `global` + `chains`; new backups
 * carry `addresses` (plus `global`/`chains` if the migration captured a
 * pre-existing flat hash alongside legacy scopes).
 *
 * When the same address appears in multiple sources, use `mergeEntries`
 * (union tags + updatedAt-newer-wins on scalars) instead of last-write-wins.
 * Otherwise importing a backup that captured both flat + legacy entries for
 * the same address would silently drop tags / notes / source from one of them.
 */
function parseLabelPayload(body: AddressLabelsSnapshot): LabelParseResult {
  // Reject the mixed `{ labels, reports }` shape explicitly. The simple
  // format uses `labels` (not `addresses`), and `isSnapshot` now matches
  // anything with a `reports` key — so a legacy `{ labels, reports }`
  // payload routes here instead of to handleSimpleFormat. Without this
  // guard, the labels would be silently ignored and the caller would see a
  // 200 with `imported.addresses = 0`. Surface the contradiction instead.
  if ((body as { labels?: unknown }).labels !== undefined) {
    return {
      error:
        "Snapshot must use `addresses` (not `labels`); a payload with both `labels` and `reports` is ambiguous — pick the simple format ({labels}) or the snapshot format ({addresses, reports}).",
    };
  }

  const merged: Record<string, AddressEntry> = {};
  function mergeIn(source: Record<string, AddressEntry>): void {
    for (const [addr, entry] of Object.entries(source)) {
      const lower = addr.toLowerCase();
      const prior = merged[lower];
      merged[lower] = prior ? mergeEntries(prior, entry) : entry;
    }
  }

  if (body.addresses !== undefined) {
    if (!isEntriesMap(body.addresses)) {
      return { error: "Invalid labels map for addresses" };
    }
    mergeIn(upgradeEntries(body.addresses as Record<string, unknown>));
  }
  if (body.global !== undefined) {
    if (!isEntriesMap(body.global)) {
      return { error: "Invalid labels map for legacy global scope" };
    }
    mergeIn(upgradeEntries(body.global as Record<string, unknown>));
  }
  if (body.chains !== undefined) {
    if (typeof body.chains !== "object" || body.chains === null) {
      return { error: "chains must be an object" };
    }
    for (const [key, labels] of Object.entries(body.chains)) {
      if (!isEntriesMap(labels)) {
        return { error: `Invalid labels map for legacy chain ${key}` };
      }
      mergeIn(upgradeEntries(labels as Record<string, unknown>));
    }
  }

  const hasLabelPayload =
    body.addresses !== undefined ||
    body.global !== undefined ||
    body.chains !== undefined;
  return { merged, hasLabelPayload };
}

async function applyReplace(
  merged: Record<string, AddressEntry>,
  reportsToImport: Record<string, AddressReport>,
  arkham: IntelSnapshotFields,
  flags: {
    hasLabelPayload: boolean;
    hasReportPayload: boolean;
    hasArkhamPayload: boolean;
  },
): Promise<number> {
  const finalLabels = flags.hasLabelPayload
    ? sanitizeAndFilter(merged)
    : undefined;
  if (
    flags.hasLabelPayload ||
    flags.hasReportPayload ||
    flags.hasArkhamPayload
  ) {
    await replaceSnapshotHashes({
      ...(finalLabels !== undefined ? { labels: finalLabels } : {}),
      ...(flags.hasReportPayload ? { reports: reportsToImport } : {}),
      ...arkham,
    });
  }
  return finalLabels ? Object.keys(finalLabels).length : 0;
}

async function applyMerge(
  merged: Record<string, AddressEntry>,
  reportsToImport: Record<string, AddressReport>,
  labelProvenanceMode: SnapshotLabelProvenanceMode,
): Promise<number> {
  let labelsToImport: Record<string, AddressEntry> | undefined;
  if (Object.keys(merged).length > 0) {
    const existing = await getLabels();
    const mergedLabels =
      labelProvenanceMode === "preserve"
        ? mergePreservingProvenance(merged, existing)
        : mergeWithExisting(merged, existing);
    labelsToImport = sanitizeAndFilter(mergedLabels);
  }
  const importedReports = Object.keys(reportsToImport).length;
  if (labelsToImport !== undefined || importedReports > 0) {
    await importSnapshotHashes({
      ...(labelsToImport !== undefined ? { labels: labelsToImport } : {}),
      ...(importedReports > 0 ? { reports: reportsToImport } : {}),
    });
  }
  return labelsToImport ? Object.keys(labelsToImport).length : 0;
}

export async function handleSnapshot(
  body: AddressLabelsSnapshot,
  options: SnapshotImportOptions,
): Promise<NextResponse> {
  const labelResult = parseLabelPayload(body);
  if ("error" in labelResult) {
    return NextResponse.json({ error: labelResult.error }, { status: 400 });
  }
  const { merged, hasLabelPayload } = labelResult;

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
  const reportsToImport = reportsValidation.reports;
  const importedReports = Object.keys(reportsToImport).length;
  const writeMode = options.writeMode ?? "merge";
  const hasReportPayload = body.reports !== undefined;

  // Intel hashes restore only via the trusted (replace) path; user-uploaded
  // imports go through the merge path which ignores them.
  const arkhamExtract =
    writeMode === "replace"
      ? extractIntelFields(body)
      : { fields: {}, hasArkhamPayload: false };

  // Surface intel-only payloads in merge mode as a 400 rather than the
  // misleading 200/zero-import response: `isSnapshot` accepts intel/legacy
  // fields so the trusted /restore route can re-upload a partial intel corpus,
  // but the user-facing /import path is label-oriented and silently drops the
  // intel payload. Operators uploading an intel-only blob to /import would
  // otherwise see "ok: true" with zero rows written and assume success.
  if (
    writeMode === "merge" &&
    isIntelOnlyPayload(body, hasLabelPayload, hasReportPayload)
  ) {
    return NextResponse.json(
      {
        error:
          "Intel hash fields are only accepted in trusted replace mode (cron restore); upload via /api/address-labels/restore or include `addresses` / `reports` in the snapshot.",
      },
      { status: 400 },
    );
  }

  if (
    isNoOpEmptyPayload({
      merged,
      importedReports,
      writeMode,
      hasLabelPayload,
      hasReportPayload,
      hasArkhamPayload: arkhamExtract.hasArkhamPayload,
    })
  ) {
    return NextResponse.json({
      ok: true,
      imported: { addresses: 0, reports: 0 },
    });
  }

  try {
    const importedAddresses = await dispatchWrite({
      writeMode,
      merged,
      reportsToImport,
      arkhamFields: arkhamExtract.fields,
      hasLabelPayload,
      hasReportPayload,
      hasArkhamPayload: arkhamExtract.hasArkhamPayload,
      labelProvenanceMode: options.labelProvenanceMode ?? "strip",
    });
    return NextResponse.json({
      ok: true,
      imported: { addresses: importedAddresses, reports: importedReports },
    });
  } catch (err) {
    return serverError(err, options.errorTag);
  }
}

function isNoOpEmptyPayload(args: {
  merged: Record<string, AddressEntry>;
  importedReports: number;
  writeMode: SnapshotWriteMode;
  hasLabelPayload: boolean;
  hasReportPayload: boolean;
  hasArkhamPayload: boolean;
}): boolean {
  // Replace mode with an explicit empty payload still goes through so callers
  // can intentionally clear a hash.
  const replaceWantsWrite =
    args.writeMode === "replace" &&
    (args.hasLabelPayload || args.hasReportPayload || args.hasArkhamPayload);
  return (
    Object.keys(args.merged).length === 0 &&
    args.importedReports === 0 &&
    !replaceWantsWrite
  );
}

async function dispatchWrite(args: {
  writeMode: SnapshotWriteMode;
  merged: Record<string, AddressEntry>;
  reportsToImport: Record<string, AddressReport>;
  arkhamFields: IntelSnapshotFields;
  hasLabelPayload: boolean;
  hasReportPayload: boolean;
  hasArkhamPayload: boolean;
  labelProvenanceMode: SnapshotLabelProvenanceMode;
}): Promise<number> {
  if (args.writeMode === "replace") {
    return applyReplace(args.merged, args.reportsToImport, args.arkhamFields, {
      hasLabelPayload: args.hasLabelPayload,
      hasReportPayload: args.hasReportPayload,
      hasArkhamPayload: args.hasArkhamPayload,
    });
  }
  return applyMerge(
    args.merged,
    args.reportsToImport,
    args.labelProvenanceMode,
  );
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
    const entry = validateSingleReportEntry(addr, payload, {
      importerEmail: options.importerEmail,
      mode,
      now,
    });
    if ("error" in entry) return { error: entry.error };
    result[addr.toLowerCase()] = entry.report;
  }
  return { reports: result };
}

function validateSingleReportEntry(
  addr: string,
  payload: unknown,
  ctx: { importerEmail: string; mode: SnapshotReportMetadataMode; now: string },
): { report: AddressReport } | { error: string } {
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

  const bodyErr = checkReportBody(addr, p);
  if (bodyErr) return { error: bodyErr };

  const titleResult = extractReportTitle(addr, p);
  if ("error" in titleResult) return { error: titleResult.error };

  if (ctx.mode === "preserve") {
    const authorErr = checkAuthorEmail(addr, p);
    if (authorErr) return { error: authorErr };
    const restored = upgradeReport(p);
    return {
      report: {
        ...restored,
        body: p.body as string,
        ...(titleResult.title ? { title: titleResult.title } : {}),
      },
    };
  }

  // Re-stamp server-controlled metadata. Importer's email + `"import"`
  // source identifies the restore round; `version: 1` resets the monotonic
  // counter (any subsequent live edit will bump from 1 → 2).
  return {
    report: {
      body: p.body as string,
      ...(titleResult.title ? { title: titleResult.title } : {}),
      authorEmail: ctx.importerEmail,
      source: "import",
      createdAt: ctx.now,
      updatedAt: ctx.now,
      version: 1,
    },
  };
}

function checkReportBody(
  addr: string,
  p: Record<string, unknown>,
): string | null {
  if (typeof p.body !== "string" || p.body.trim() === "") {
    return `Report for ${addr} has an empty or non-string body`;
  }
  if (p.body.length > MAX_REPORT_BODY_LENGTH) {
    return `Report for ${addr} body exceeds ${MAX_REPORT_BODY_LENGTH} characters`;
  }
  return null;
}

function extractReportTitle(
  addr: string,
  p: Record<string, unknown>,
): { title?: string } | { error: string } {
  if (p.title === undefined || p.title === null) return {};
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
  return trimmed ? { title: trimmed } : {};
}

function checkAuthorEmail(
  addr: string,
  p: Record<string, unknown>,
): string | null {
  if (p.authorEmail === undefined || p.authorEmail === null) return null;
  if (typeof p.authorEmail !== "string" || !/@/.test(p.authorEmail)) {
    return `Report for ${addr} has invalid authorEmail`;
  }
  return null;
}

function isIntelOnlyPayload(
  body: AddressLabelsSnapshot,
  hasLabelPayload: boolean,
  hasReportPayload: boolean,
): boolean {
  if (hasLabelPayload || hasReportPayload) return false;
  const obj = body as Record<string, unknown>;
  return (
    INTEL_SNAPSHOT_KEYS.some((k) => obj[k] !== undefined) ||
    ARKHAM_LEGACY_SNAPSHOT_KEYS.some((k) => obj[k] !== undefined)
  );
}

const INTEL_SNAPSHOT_KEYS = [
  "intelDeep",
  "intelTransfers",
  "intelWealth",
  "intelEntities",
  "intelEntityCps",
] as const;

// Legacy field names — read-only, accepted on restore for backup compat.
const ARKHAM_LEGACY_SNAPSHOT_KEYS = [
  "arkhamDeep",
  "arkhamTransfers",
  "arkhamWealth",
  "arkhamEntities",
  "arkhamEntityCps",
] as const;

export function isSnapshot(v: unknown): v is AddressLabelsSnapshot {
  if (typeof v !== "object" || v === null) return false;
  // A snapshot has at least one of `addresses`, `global`, `chains`, `reports`,
  // or any intel/legacy marathon hash fields — the latter let partial
  // disaster-recovery restores (re-uploading just the intel corpus) succeed
  // instead of returning the misleading "not an address-label snapshot" 400.
  const obj = v as Record<string, unknown>;
  return (
    "addresses" in obj ||
    "global" in obj ||
    "chains" in obj ||
    "reports" in obj ||
    INTEL_SNAPSHOT_KEYS.some((key) => key in obj) ||
    ARKHAM_LEGACY_SNAPSHOT_KEYS.some((key) => key in obj)
  );
}

/**
 * Validates that a value is a map of address → entry objects.
 * Accepts both v1 (label field) and v2 (name field) entry shapes.
 * This is only a structural gate; sanitizeAndFilter handles content filtering
 * after legacy entries are upgraded.
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

type IntelSnapshotFields = {
  intelDeep?: AddressLabelsSnapshot["intelDeep"];
  intelTransfers?: AddressLabelsSnapshot["intelTransfers"];
  intelWealth?: AddressLabelsSnapshot["intelWealth"];
  intelEntities?: AddressLabelsSnapshot["intelEntities"];
  intelEntityCps?: AddressLabelsSnapshot["intelEntityCps"];
};

/**
 * Extract intel hashes from a snapshot body for pass-through to the restore
 * writer. Trusted (cron-restore) mode only — no sanitization; the cron wrote
 * exactly what it read out of Redis. Accepts both new (`intelDeep`) and legacy
 * (`arkhamDeep`) field names so older Blob backups can still be restored.
 *
 * Empty `{}` maps are stripped alongside `undefined`: a backup captured while
 * Redis was empty (e.g. between deploy and the rename migration) would otherwise
 * route into the trusted-replace path and DEL the live intel hashes, wiping
 * the marathon corpus on disaster-recovery restore.
 */
function extractIntelFields(body: AddressLabelsSnapshot): {
  fields: IntelSnapshotFields;
  hasArkhamPayload: boolean;
} {
  const fields: IntelSnapshotFields = {};
  // Prefer new names; fall back to legacy names for older backups.
  fields.intelDeep = body.intelDeep ?? body.arkhamDeep;
  fields.intelTransfers = body.intelTransfers ?? body.arkhamTransfers;
  fields.intelWealth = body.intelWealth ?? body.arkhamWealth;
  fields.intelEntities = body.intelEntities ?? body.arkhamEntities;
  fields.intelEntityCps = body.intelEntityCps ?? body.arkhamEntityCps;
  for (const k of Object.keys(fields) as Array<keyof IntelSnapshotFields>) {
    const v = fields[k];
    if (
      v === undefined ||
      (typeof v === "object" && v !== null && Object.keys(v).length === 0)
    ) {
      delete fields[k];
    }
  }
  return { fields, hasArkhamPayload: Object.keys(fields).length > 0 };
}

function mergePreservingProvenance(
  incoming: Record<string, AddressEntry>,
  existing: Record<string, AddressEntry>,
): Record<string, AddressEntry> {
  // Future-proofing for non-replace trusted restore callers. The current Blob
  // restore uses writeMode="replace", so it preserves provenance via
  // replaceSnapshotHashes.
  const out: Record<string, AddressEntry> = {};
  for (const [addr, entry] of Object.entries(incoming)) {
    const prev = existing[addr.toLowerCase()];
    if (!prev) {
      out[addr] = entry;
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
    out[addr] = {
      ...prev,
      ...incomingDefined,
      tags: entry.tags,
    } as AddressEntry;
  }
  return out;
}

function serverError(err: unknown, routeTag = "address-labels/import") {
  // Full error is in Sentry; return a generic string to the client.
  Sentry.captureException(err, { tags: { route: routeTag } });
  console.error(`[${routeTag}]`, err);
  return NextResponse.json({ error: "Import failed" }, { status: 500 });
}
