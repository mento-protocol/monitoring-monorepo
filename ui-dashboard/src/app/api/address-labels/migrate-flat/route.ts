import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { put } from "@vercel/blob";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import {
  type AddressEntry,
  type AddressLabelsSnapshot,
  dropLegacyScopes,
  getFlatLabels,
  getLabelsByAddress,
  importLabels,
  readLegacyScopes,
} from "@/lib/address-labels";

export const runtime = "nodejs";
export const maxDuration = 300;

type ConflictRecord = {
  address: string;
  /** Redis key names where this address appeared (e.g. `labels:42220`). */
  sources: string[];
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
 *   - name / notes / isPublic: prefer the more recent (max updatedAt) source;
 *     ties resolve to `incoming`.
 *
 * Idempotent: a second run with no legacy keys present is a clean no-op.
 *
 * Auth: dual — `Bearer CRON_SECRET` OR an authenticated `@mentolabs.xyz`
 * session. The migration runs once after deploy via `curl` from a maintainer
 * laptop. The route is exempted from the address-labels middleware (mirrors
 * `/backup`) so the bearer-token path actually reaches the handler.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireMigrationAuth(req);
  if (authBail) return authBail;

  const startedAt = Date.now();
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

  try {
    const [{ legacyKeys, scopes }, preExistingFlat] = await Promise.all([
      readLegacyScopes(),
      // Flat-only read so user edits made via the UI during the deploy →
      // migration window survive the merge. The dual-read `getLabels()`
      // would double-count legacy entries here.
      getFlatLabels(),
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

    // Build the flat merged map. Seed with pre-existing flat entries first
    // so user PUTs made during the dual-read transition window aren't
    // silently overwritten by stale legacy data; mergeEntries' updatedAt
    // tiebreaker still picks the freshest scalar fields per address.
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
        conflicts.push({ address, sources, resolved: merged[address] });
      }
    }

    if (dryRun) {
      // Dry runs are read-only — no Blob write, no HSET, no DEL. Return
      // the merge plan so a maintainer can spot-check before the live run.
      const body: MigrateResponse = {
        ok: true,
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

    // Always back up before mutating Redis. Snapshot uses the importable
    // shape (`{exportedAt, global, chains}`) so the backup can round-trip
    // through `/api/address-labels/import` if rollback is needed. Blob is
    // private so it doesn't leak via dashboard download.
    const backupPathname = await writeBackup(scopes);

    await importLabels(merged);

    // HMGET only the addresses we just wrote — confirm every one landed.
    // HGETALL would re-pull the entire flat hash including pre-existing
    // entries we didn't touch.
    const expected = Object.keys(merged);
    const verify = await getLabelsByAddress(expected);
    const missing = expected.filter((_, i) => verify[i] === null);
    if (missing.length > 0) {
      throw new Error(
        `flat-write verification failed: ${missing.length} address(es) missing after import (sample: ${missing.slice(0, 3).join(", ")})`,
      );
    }

    await dropLegacyScopes(legacyKeys);

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
 * Merge a prior entry with an incoming one. Resolution: union tags
 * (case-insensitive dedup), prefer the more recently updated entry's
 * scalar fields, take the earliest createdAt. Ties on `updatedAt` resolve
 * in favour of `incoming`.
 *
 * `name` is taken from `newer` directly — empty-name tag-only entries are
 * meaningful in this codebase, so a truthiness fallback (`newer.name ||
 * older.name`) would resurrect a stale older name when the newer write
 * intentionally cleared it.
 */
function mergeEntries(
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
  const createdAt = createdCandidates.sort()[0];

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
 * Write a pre-migration snapshot to Vercel Blob using the same shape the
 * `/api/address-labels/import` route accepts (`{exportedAt, global,
 * chains}`). If rollback is ever needed, the operator can download the
 * blob and POST it back through the import endpoint without translation.
 */
async function writeBackup(
  scopes: Array<{ key: string; entries: Record<string, AddressEntry> }>,
): Promise<string> {
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `address-labels-pre-migrate-flat-${date}.json`;
  const snapshot: AddressLabelsSnapshot = {
    exportedAt: new Date().toISOString(),
  };
  const chains: Record<string, Record<string, AddressEntry>> = {};
  for (const { key, entries } of scopes) {
    if (key === "labels:global") {
      snapshot.global = entries;
      continue;
    }
    const chainId = key.slice("labels:".length);
    if (/^\d+$/.test(chainId)) chains[chainId] = entries;
  }
  if (Object.keys(chains).length > 0) snapshot.chains = chains;

  const blob = await put(filename, JSON.stringify(snapshot, null, 2), {
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

  // Mirror the middleware's domain enforcement: a bare `getAuthSession()`
  // session isn't enough since a forged JWT (e.g. leaked AUTH_SECRET) with
  // an arbitrary email would otherwise pass.
  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (email && email.endsWith(ALLOWED_DOMAIN)) return null;

  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}
