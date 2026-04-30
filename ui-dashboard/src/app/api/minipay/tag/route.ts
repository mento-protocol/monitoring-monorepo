import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAllLabels, importLabels } from "@/lib/address-labels";
import type { AddressEntry } from "@/lib/address-labels-shared";
import { discoverMentoAddresses } from "@/lib/arkham-discovery";
import { requireCronAuth } from "@/lib/cron-auth";
import {
  getMiniPaySetSize,
  intersectMiniPay,
  toMiniPayEntry,
} from "@/lib/minipay";
import { NETWORKS } from "@/lib/networks";

// `nodejs` for fetch + Redis pacing; 800s budget covers a full Mento
// universe scan + chunked SMISMEMBER + chunked importLabels write.
export const runtime = "nodejs";
export const maxDuration = 800;

// FederatedAttestations is a Celo contract; the discovery is gated on Celo
// for parity with Arkham. Monad has no MiniPay surface today.
const CELO_CHAIN_ID = NETWORKS["celo-mainnet"].chainId;
const DEFAULT_MAX_ADDRESSES = 10_000;

type TagMode = "new" | "dryRun";

type TagResponse = {
  ok: boolean;
  mode: TagMode;
  /** Total Mento addresses discovered before any filtering. */
  discovered: number;
  /** After dropping addresses with any existing label. */
  candidates: number;
  /** SET cardinality at run start — sanity surface for cron logs. */
  minipaySetSize: number;
  /** Addresses confirmed as MiniPay users by SMISMEMBER. */
  matched: number;
  /** Rows actually written (0 in dryRun). */
  written: number;
  /** In `dryRun` mode, the addresses we would have written. Omitted in `new`
   *  mode to keep production cron payloads small. */
  wouldWrite?: string[];
  durationMs: number;
  perEntity?: Array<{ table: string; field: string; count: number }>;
};

function parseMode(raw: string | null): TagMode {
  if (raw === "dryRun") return "dryRun";
  return "new";
}

function parseLimit(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_ADDRESSES;
  const n = Number(raw);
  if (n === 0) return DEFAULT_MAX_ADDRESSES;
  return Math.min(n, DEFAULT_MAX_ADDRESSES);
}

/**
 * Cron-triggered tagging of Mento addresses that appear in the MiniPay
 * attestation set.
 *
 * Auth: Bearer `CRON_SECRET`.
 *
 * Query params:
 * - `mode=new` (default) — drop any address that already carries a label.
 *   Rationale: an Arkham-tagged "Binance hot wallet" appearing in the
 *   MiniPay set is noise, and overwriting a manual label would surprise
 *   users. MiniPay only writes to addresses with no other provenance.
 * - `mode=dryRun` — compute the would-write payload without persisting.
 * - `limit=N` — hard cap on candidates (default 10000).
 *
 * No `mode=refresh`: an attestation either exists or doesn't. Once an
 * address is tagged, refreshing adds nothing. Drift detection (revocations)
 * would be a separate read-only audit job.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronAuth(req, "minipay/tag");
  if (authBail) return authBail;

  const hasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL;
  if (!hasuraUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_HASURA_URL is not configured" },
      { status: 500 },
    );
  }

  const mode = parseMode(req.nextUrl.searchParams.get("mode"));
  const maxAddresses = parseLimit(req.nextUrl.searchParams.get("limit"));
  const startedAt = Date.now();

  try {
    return await Sentry.withMonitor(
      "minipay-tag",
      async () => {
        // SCARD is a single Redis call; check it first before paying for the
        // Hasura paginated walk + getAllLabels SCAN, which are only useful
        // when the set is populated.
        const minipaySetSize = await getMiniPaySetSize();

        if (minipaySetSize === 0) {
          // Sync cron hasn't populated the set yet (or it was wiped). Return
          // a clean no-op so the cron still checks-in to Sentry; throwing
          // would page on a recoverable state (next sync run repopulates).
          const body: TagResponse = {
            ok: true,
            mode,
            discovered: 0,
            candidates: 0,
            minipaySetSize: 0,
            matched: 0,
            written: 0,
            durationMs: Date.now() - startedAt,
          };
          return NextResponse.json(body);
        }

        const [discovery, allLabels] = await Promise.all([
          discoverMentoAddresses(hasuraUrl, CELO_CHAIN_ID),
          getAllLabels(),
        ]);

        const { addresses, perEntity } = discovery;

        // Flatten every scope into one map for filtering. Same rationale as
        // arkham/enrich/route.ts:135-138 — strict either/or invariant means
        // no key collisions; we filter against the union so we don't write
        // a duplicate when a legacy chain-scoped row exists.
        const existing: Record<string, AddressEntry> = { ...allLabels.global };
        for (const chainEntries of Object.values(allLabels.chains)) {
          Object.assign(existing, chainEntries);
        }

        // Drop anything already labelled by any source. MiniPay writes only
        // to fresh addresses to avoid stomping Arkham/manual labels.
        const candidates = addresses
          .map((a) => a.toLowerCase())
          .filter((a) => !existing[a]);

        // Intersect before slicing: `discoverMentoAddresses` returns
        // alphabetically-sorted addresses, so a `.slice(0, maxAddresses)`
        // applied to candidates would silently hide MiniPay users with
        // higher-prefix addresses if the universe ever exceeds the cap.
        // SMISMEMBER is the cheap step (chunked, ~10 round-trips per 10k).
        const allMatches = await intersectMiniPay(candidates);
        const matches = allMatches.slice(0, maxAddresses);

        const toWrite: Record<string, AddressEntry> = {};
        for (const addr of matches) {
          toWrite[addr] = toMiniPayEntry();
        }

        if (mode !== "dryRun" && Object.keys(toWrite).length > 0) {
          // Write to global scope — MiniPay attestations are issued on Celo
          // but the EOA itself is chain-agnostic. Mirrors the Arkham scope
          // choice (arkham/enrich/route.ts:178-185).
          await importLabels("global", toWrite);
        }

        const body: TagResponse = {
          ok: true,
          mode,
          discovered: addresses.length,
          candidates: candidates.length,
          minipaySetSize,
          matched: matches.length,
          written: mode === "dryRun" ? 0 : Object.keys(toWrite).length,
          ...(mode === "dryRun" ? { wouldWrite: matches } : {}),
          durationMs: Date.now() - startedAt,
          perEntity,
        };
        return NextResponse.json(body);
      },
      {
        // Cron schedule mirrors vercel.json — keep them in sync.
        schedule: { type: "crontab", value: "0 5 * * *" },
        checkinMargin: 5,
        maxRuntime: 15,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "minipay/tag", mode } });
    console.error("[minipay/tag]", err);
    return NextResponse.json({ error: "Tagging failed" }, { status: 500 });
  }
}
