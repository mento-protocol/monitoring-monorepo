import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { get } from "@vercel/blob";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { handleSnapshot, isSnapshot } from "@/lib/address-labels/snapshot";
import {
  type BackupManifestV2,
  isBackupManifestV2,
  type SnapshotHashName,
} from "@/lib/address-labels/backup-format";
import type { AddressLabelsSnapshot } from "@/lib/address-labels";
import { isValidAddress } from "@/lib/format";
export const runtime = "nodejs";
export const maxDuration = 300;

// Per-blob byte cap. With v2 per-hash blob splits no single blob crosses
// ~10 MB, so 16 MB is comfortable headroom; v1 monolithic blobs ran up to
// the older 32 MB cap before the per-hash format landed — we keep the
// higher cap for legacy-blob restore paths only.
export const MAX_RESTORE_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_BLOB_BYTES = 32 * 1024 * 1024;

// Mapping from v2 manifest `name` to the AddressLabelsSnapshot field name.
// `labels` slots into `addresses` (snapshot type predates the per-hash split
// rename); the other six are 1:1.
const SNAPSHOT_FIELD_BY_HASH_NAME: Record<
  SnapshotHashName,
  keyof AddressLabelsSnapshot
> = {
  labels: "addresses",
  reports: "reports",
  intelDeep: "intelDeep",
  intelTransfers: "intelTransfers",
  intelWealth: "intelWealth",
  intelEntities: "intelEntities",
  intelEntityCps: "intelEntityCps",
};

type RestoreActor =
  | { kind: "cron"; importerEmail: "restore@cron" }
  | { kind: "session"; importerEmail: string };

/**
 * Server-side restore from a private Vercel Blob snapshot.
 *
 * Unlike `/api/address-labels/import`, this path does not accept user-uploaded
 * content. It reads first-party cron/migration snapshots from the private Blob
 * store, so forensic-report metadata is preserved verbatim instead of
 * re-stamped to the current session. The uploaded import route deliberately
 * keeps re-stamping to prevent forged authorship in untrusted files.
 *
 * Restore replaces the labels/reports hashes in one Redis script when both are
 * present, so Redis never lands on a mixed snapshot across those hashes. The
 * Blob size cap is kept below Upstash's request ceiling because the script
 * carries all replacement fields in one request.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const auth = await requireRestoreAuth(req);
  if (auth instanceof Response) return auth;

  const pathname = req.nextUrl.searchParams.get("pathname")?.trim() ?? "";
  if (!pathname) {
    return NextResponse.json(
      { error: "Missing required `pathname` query parameter" },
      { status: 400 },
    );
  }
  if (!isAllowedRestorePathname(pathname)) {
    return NextResponse.json(
      { error: "Unsupported restore pathname" },
      { status: 400 },
    );
  }

  try {
    // v2 path: a manifest reference. Fetch manifest, then fetch each hash
    // blob in parallel and assemble the snapshot in memory before handing
    // off to handleSnapshot (which expects an AddressLabelsSnapshot shape).
    if (isManifestPathname(pathname)) {
      const assembled = await assembleSnapshotFromManifest(pathname);
      if (assembled instanceof Response) return assembled;
      return await handleSnapshot(assembled, restoreSnapshotOptions(auth));
    }

    // v1 legacy path: monolithic blob containing the full snapshot.
    return await restoreLegacyMonolithicBlob(pathname, auth);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/restore" } });
    console.error("[address-labels/restore]", err);
    return NextResponse.json({ error: "Restore failed" }, { status: 500 });
  }
}

function restoreSnapshotOptions(auth: {
  importerEmail: string;
}): Parameters<typeof handleSnapshot>[1] {
  return {
    importerEmail: auth.importerEmail,
    // Workspace sessions get the same trusted-restore mode as cron because
    // this route only reads allowlisted first-party private Blob snapshots.
    reportMetadataMode: "preserve",
    labelProvenanceMode: "preserve",
    writeMode: "replace",
    errorTag: "address-labels/restore",
  };
}

function isManifestPathname(pathname: string): boolean {
  return /^address-labels-backup-\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(
    pathname,
  );
}

/**
 * Fetch + parse the manifest, then fetch each referenced hash blob in
 * parallel and inline them into a single in-memory AddressLabelsSnapshot.
 * Returns a Response on any pre-snapshot failure (404, oversized blob,
 * malformed JSON), or the assembled snapshot ready for handleSnapshot.
 */
async function assembleSnapshotFromManifest(
  manifestPathname: string,
): Promise<AddressLabelsSnapshot | Response> {
  const manifestBlob = await fetchPrivateBlobText(
    manifestPathname,
    MAX_RESTORE_BLOB_BYTES,
  );
  if (manifestBlob instanceof Response) return manifestBlob;

  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(manifestBlob);
  } catch {
    return NextResponse.json(
      { error: "Manifest blob does not contain valid JSON" },
      { status: 400 },
    );
  }
  if (!isBackupManifestV2(manifestParsed)) {
    return NextResponse.json(
      { error: "Manifest blob is not a v2 backup manifest" },
      { status: 400 },
    );
  }
  const manifest: BackupManifestV2 = manifestParsed;

  // Fetch every hash blob in parallel. Each fetch enforces its own size cap.
  const hashFetches = await Promise.all(
    manifest.hashes.map(async (entry) => {
      const text = await fetchPrivateBlobText(
        entry.pathname,
        MAX_RESTORE_BLOB_BYTES,
      );
      return { entry, text };
    }),
  );

  const snapshot: AddressLabelsSnapshot = { exportedAt: manifest.exportedAt };
  for (const { entry, text } of hashFetches) {
    if (text instanceof Response) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `Hash blob ${entry.pathname} does not contain valid JSON` },
        { status: 400 },
      );
    }
    const validationError = validateHashBlobRecord(entry.name, parsed);
    if (validationError) {
      return NextResponse.json(
        { error: `Hash blob ${entry.pathname} ${validationError}` },
        { status: 400 },
      );
    }
    const field = SNAPSHOT_FIELD_BY_HASH_NAME[entry.name];
    // Re-cast through `as never` because the field's value type differs per
    // SnapshotHashName but the manifest schema guarantees the parsed value
    // matches that field's record shape (HGETALL → JSON → HGETALL roundtrip).
    (snapshot as Record<string, unknown>)[field] = parsed;
  }
  return snapshot;
}

function validateHashBlobRecord(
  name: SnapshotHashName,
  value: unknown,
): string | null {
  if (!isRecordMap(value)) return "is not a record map";
  if (name === "labels") return validateLabelRecords(value);
  if (name === "reports") return validateReportRecords(value);
  return validateObjectRecordValues(name, value);
}

function isRecordMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLabelRecords(records: Record<string, unknown>): string | null {
  for (const [address, entry] of Object.entries(records)) {
    if (!isValidAddress(address)) {
      return `contains invalid label address ${address}`;
    }
    if (!isRecordMap(entry)) {
      return `contains invalid label payload for ${address}`;
    }
    const hasName =
      (typeof entry.label === "string" && entry.label.trim() !== "") ||
      (typeof entry.name === "string" && entry.name.trim() !== "");
    const hasTags = Array.isArray(entry.tags) && entry.tags.length > 0;
    if (!hasName && !hasTags) {
      return `contains invalid label payload for ${address}`;
    }
  }
  return null;
}

function validateReportRecords(
  records: Record<string, unknown>,
): string | null {
  for (const [address, report] of Object.entries(records)) {
    if (!isValidAddress(address)) {
      return `contains invalid report address ${address}`;
    }
    if (!isRecordMap(report) || typeof report.body !== "string") {
      return `contains invalid report payload for ${address}`;
    }
    if (report.body.trim() === "") {
      return `contains empty report body for ${address}`;
    }
  }
  return null;
}

function validateObjectRecordValues(
  name: SnapshotHashName,
  records: Record<string, unknown>,
): string | null {
  for (const [key, record] of Object.entries(records)) {
    if (!isRecordMap(record)) {
      return `contains invalid ${name} payload for ${key}`;
    }
  }
  return null;
}

async function restoreLegacyMonolithicBlob(
  pathname: string,
  auth: { importerEmail: string },
): Promise<Response> {
  const text = await fetchPrivateBlobText(pathname, MAX_LEGACY_BLOB_BYTES);
  if (text instanceof Response) return text;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Snapshot blob does not contain valid JSON" },
      { status: 400 },
    );
  }
  if (!isSnapshot(body)) {
    return NextResponse.json(
      { error: "Blob is not an address-label snapshot" },
      { status: 400 },
    );
  }
  return await handleSnapshot(body, restoreSnapshotOptions(auth));
}

/**
 * Fetch a private Blob and read its body as UTF-8, enforcing a byte cap.
 * Returns the decoded string on success, or a NextResponse describing the
 * failure (404 not found, 413 too large, etc.). Consolidates the get/size/
 * read/cancel boilerplate used by both v1 and v2 paths.
 */
async function fetchPrivateBlobText(
  pathname: string,
  maxBytes: number,
): Promise<string | Response> {
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    abortSignal: AbortSignal.timeout(30_000),
  });
  if (result?.statusCode !== 200 || !result.stream) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }
  if (result.blob.size !== null && result.blob.size > maxBytes) {
    return NextResponse.json(
      { error: "Snapshot is too large to restore safely" },
      { status: 413 },
    );
  }

  const text = await readBoundedUtf8(result.stream, maxBytes);
  if (text === null) {
    return NextResponse.json(
      { error: "Snapshot is too large to restore safely" },
      { status: 413 },
    );
  }
  return text;
}

async function requireRestoreAuth(
  req: NextRequest,
): Promise<RestoreActor | Response> {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = req.headers.get("authorization");
  if (cronSecret && authorization === `Bearer ${cronSecret}`) {
    return { kind: "cron", importerEmail: "restore@cron" };
  }

  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (email && email.endsWith(ALLOWED_DOMAIN)) {
    return { kind: "session", importerEmail: email };
  }

  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}

function isAllowedRestorePathname(pathname: string): boolean {
  if (pathname.includes("..") || pathname.startsWith("/")) return false;
  return (
    // v2 manifest (current)
    /^address-labels-backup-\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(
      pathname,
    ) ||
    // v1 monolithic blob (legacy, restore-only)
    /^address-labels-backup-\d{4}-\d{2}-\d{2}\.json$/.test(pathname) ||
    // pre-migrate flat snapshots (historic)
    /^address-labels-pre-migrate-flat-\d{4}-\d{2}-\d{2}[\w-]*\.json$/.test(
      pathname,
    )
  );
}

async function readBoundedUtf8(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // Stream reads are intentionally sequential: each `read()` advances the
      // same reader cursor and enforces the byte cap before accepting a chunk.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
