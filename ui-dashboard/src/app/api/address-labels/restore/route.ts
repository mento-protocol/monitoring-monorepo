import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { get } from "@vercel/blob";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { handleSnapshot, isSnapshot } from "@/lib/address-labels/snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_RESTORE_BLOB_BYTES = 32 * 1024 * 1024;

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
 * Labels and reports are separate Redis hashes, so replace-mode restore writes
 * them in two operations. If a restore is interrupted between those writes,
 * rerun the same pathname to converge both hashes to the selected snapshot.
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
    const result = await get(pathname, {
      access: "private",
      useCache: false,
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (result?.statusCode !== 200 || !result.stream) {
      return NextResponse.json(
        { error: "Snapshot not found" },
        { status: 404 },
      );
    }
    if (
      result.blob.size !== null &&
      result.blob.size > MAX_RESTORE_BLOB_BYTES
    ) {
      return NextResponse.json(
        { error: "Snapshot is too large to restore safely" },
        { status: 413 },
      );
    }

    const text = await new Response(result.stream).text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESTORE_BLOB_BYTES) {
      return NextResponse.json(
        { error: "Snapshot is too large to restore safely" },
        { status: 413 },
      );
    }

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

    return handleSnapshot(body, {
      importerEmail: auth.importerEmail,
      // Workspace sessions get the same trusted-restore mode as cron because
      // this route only reads allowlisted first-party private Blob snapshots.
      reportMetadataMode: "preserve",
      labelProvenanceMode: "preserve",
      writeMode: "replace",
      errorTag: "address-labels/restore",
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "address-labels/restore" } });
    console.error("[address-labels/restore]", err);
    return NextResponse.json({ error: "Restore failed" }, { status: 500 });
  }
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
    /^address-labels-backup-\d{4}-\d{2}-\d{2}\.json$/.test(pathname) ||
    /^address-labels-pre-migrate-flat-\d{4}-\d{2}-\d{2}[\w-]*\.json$/.test(
      pathname,
    )
  );
}
