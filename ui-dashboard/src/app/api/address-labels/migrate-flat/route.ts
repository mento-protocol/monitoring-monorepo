import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { getAuthSession } from "@/auth";
import {
  getLabels,
  importLabels,
  readLegacyScopes,
  dropLegacyScopes,
  type AddressEntry,
} from "@/lib/address-labels";

export const runtime = "nodejs";
export const maxDuration = 300;

type ConflictRecord = {
  address: string;
  scopes: string[];
  resolved: AddressEntry;
};

type MigrateResponse = {
  ok: boolean;
  /** Pathname of the pre-migration snapshot in Vercel Blob (private). */
  backupPathname?: string;
  /** Number of legacy scope hashes scanned. */
  legacyScopes: number;
  /** Total addresses across legacy scopes (with duplicates counted per scope). */
  legacyEntries: number;
  /** Pre-existing entries in the new flat `labels` key. */
  preExistingFlat: number;
  /** Distinct addresses written to the flat `labels` key after merge. */
  written: number;
  /** Addresses that appeared in more than one source (legacy or pre-existing flat). */
  conflicts: ConflictRecord[];
  /** True iff legacy scope keys were deleted (post-merge cleanup ran). */
  legacyDropped: boolean;
  durationMs: number;
};

/**
 * One-shot migration: collapses every `labels:{chainId}` + legacy `labels:global`
 * hash into a single flat `labels` hash keyed by lowercase address.
 *
 * Conflict resolution (same address in 2+ sources):
 *   - tags: union (case-insensitive dedup)
 *   - source: prefer non-empty (server-side cron provenance is authoritative)
 *   - createdAt: earliest non-empty
 *   - updatedAt: latest
 *   - name / notes / isPublic: prefer the most recent (max updatedAt) source
 *
 * Idempotent: a second run with no legacy keys present is a clean no-op.
 *
 * Auth: dual — `Bearer CRON_SECRET` OR an authenticated `@mentolabs.xyz`
 * session. The migration runs once after deploy via `curl` from a maintainer
 * laptop.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireMigrationAuth(req);
  if (authBail) return authBail;

  const startedAt = Date.now();
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

  try {
    const [{ scopes }, preExistingFlat] = await Promise.all([
      readLegacyScopes(),
      getLabels(),
    ]);

    const legacyEntries = scopes.reduce(
      (sum, s) => sum + Object.keys(s.entries).length,
      0,
    );

    if (scopes.length === 0) {
      const body: MigrateResponse = {
        ok: true,
        legacyScopes: 0,
        legacyEntries: 0,
        preExistingFlat: Object.keys(preExistingFlat).length,
        written: 0,
        conflicts: [],
        legacyDropped: false,
        durationMs: Date.now() - startedAt,
      };
      return NextResponse.json(body);
    }

    // Always back up before mutating Redis. Snapshot includes both legacy
    // shape (so import can round-trip) and the existing flat key. Blob is
    // private so it doesn't leak via dashboard download.
    const backupPathname = await writeBackup({
      scopes,
      preExistingFlat,
    });

    // Build the flat merged map. Walk legacy scopes first (each scope's entries
    // are timestamped); when an address appears in multiple sources, resolve
    // via mergeEntries below.
    const merged: Record<string, AddressEntry> = {};
    const sourcesByAddress = new Map<string, string[]>();

    for (const [address, entry] of Object.entries(preExistingFlat)) {
      const lower = address.toLowerCase();
      merged[lower] = entry;
      sourcesByAddress.set(lower, ["labels"]);
    }

    for (const { key, entries } of scopes) {
      for (const [address, entry] of Object.entries(entries)) {
        const lower = address.toLowerCase();
        const prior = merged[lower];
        if (prior) {
          merged[lower] = mergeEntries(prior, entry);
          sourcesByAddress.get(lower)?.push(key);
        } else {
          merged[lower] = entry;
          sourcesByAddress.set(lower, [key]);
        }
      }
    }

    const conflicts: ConflictRecord[] = [];
    for (const [address, sources] of sourcesByAddress) {
      if (sources.length > 1) {
        conflicts.push({ address, scopes: sources, resolved: merged[address] });
      }
    }

    if (dryRun) {
      const body: MigrateResponse = {
        ok: true,
        backupPathname,
        legacyScopes: scopes.length,
        legacyEntries,
        preExistingFlat: Object.keys(preExistingFlat).length,
        written: 0,
        conflicts,
        legacyDropped: false,
        durationMs: Date.now() - startedAt,
      };
      return NextResponse.json(body);
    }

    await importLabels(merged);

    // Verify the merge before dropping legacy keys: re-read the flat hash and
    // confirm every merged address landed. Fail loud if it didn't — we have
    // the backup to restore from.
    const verify = await getLabels();
    const expected = Object.keys(merged);
    const missing = expected.filter((a) => !verify[a]);
    if (missing.length > 0) {
      throw new Error(
        `flat-write verification failed: ${missing.length} address(es) missing after import (sample: ${missing.slice(0, 3).join(", ")})`,
      );
    }

    await dropLegacyScopes();

    const body: MigrateResponse = {
      ok: true,
      backupPathname,
      legacyScopes: scopes.length,
      legacyEntries,
      preExistingFlat: Object.keys(preExistingFlat).length,
      written: expected.length,
      conflicts,
      legacyDropped: true,
      durationMs: Date.now() - startedAt,
    };
    return NextResponse.json(body);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "address-labels/migrate-flat" },
    });
    console.error("[address-labels/migrate-flat]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Migration failed",
      },
      { status: 500 },
    );
  }
}

/**
 * Merge two entries that exist for the same address in different sources.
 * Resolution rules: union tags, prefer the more recently updated entry for
 * scalar fields, take the earliest createdAt.
 */
function mergeEntries(a: AddressEntry, b: AddressEntry): AddressEntry {
  const aLater = (a.updatedAt ?? "") >= (b.updatedAt ?? "");
  const newer = aLater ? a : b;
  const older = aLater ? b : a;

  const tagSet = new Map<string, string>();
  for (const t of [...older.tags, ...newer.tags]) {
    const key = t.toLowerCase();
    if (!tagSet.has(key)) tagSet.set(key, t);
  }

  const createdCandidates = [a.createdAt, b.createdAt].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const createdAt = createdCandidates.sort()[0];

  return {
    name: newer.name || older.name,
    tags: Array.from(tagSet.values()),
    notes: newer.notes ?? older.notes,
    isPublic: newer.isPublic ?? older.isPublic,
    source: newer.source ?? older.source,
    ...(createdAt ? { createdAt } : {}),
    updatedAt: newer.updatedAt,
  };
}

async function writeBackup(payload: {
  scopes: Array<{ key: string; entries: Record<string, AddressEntry> }>;
  preExistingFlat: Record<string, AddressEntry>;
}): Promise<string> {
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `address-labels-pre-migrate-flat-${date}.json`;
  const body = {
    capturedAt: new Date().toISOString(),
    legacyScopes: payload.scopes,
    preExistingFlat: payload.preExistingFlat,
  };
  const blob = await put(filename, JSON.stringify(body, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
  });
  return blob.pathname;
}

async function requireMigrationAuth(
  req: NextRequest,
): Promise<NextResponse | null> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${cronSecret}`) return null;

  const session = await getAuthSession();
  if (session) return null;

  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}
