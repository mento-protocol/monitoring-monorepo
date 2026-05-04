import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAllLabels, importLabels } from "@/lib/address-labels";
import type { AddressEntry } from "@/lib/address-labels-shared";
import {
  ArkhamAuthError,
  enrichBatch,
  fetchHealth,
  filterCandidates,
  mergeRefreshEntry,
  type EnrichmentResult,
} from "@/lib/arkham";
import { discoverMentoAddresses } from "@/lib/mento-address-discovery";
import { requireCronAuth } from "@/lib/cron-auth";
import { NETWORKS } from "@/lib/networks";

// Vercel hobby/pro hard caps the per-invocation duration on `serverless` —
// a 5k-address run at 60ms spacing is ~5 minutes which fits in the 800s
// fluid-compute / 300s pro budget. `nodejs` is required (Edge runtime
// rejects long-running fetch loops + has no setTimeout pacer).
export const runtime = "nodejs";
export const maxDuration = 800;

// Discovery scans Celo (the chain Mento runs on); enrichment hits Arkham's
// `/all` endpoint which returns every chain Arkham covers. EVM addresses are
// chain-agnostic, so a Binance hot-wallet seen on Celo via a bridge inflow
// gets the same Binance entity attribution Arkham assigns it on Ethereum/BSC.
const CELO_CHAIN_ID = NETWORKS["celo-mainnet"].chainId;
const DEFAULT_MAX_ADDRESSES = 10_000;

type EnrichMode = "new" | "refresh" | "dryRun";

type EnrichResponse = {
  ok: boolean;
  /** Scope written to. Defaults to "global" since EVM addresses are
   *  chain-agnostic — a Binance hot-wallet labelled by Arkham applies to
   *  every chain it appears on. */
  scope: "global";
  /** Chain we discovered candidate addresses on (always Celo). */
  discoveryChainId: number;
  discovered: number;
  candidates: number;
  enriched: number;
  skipped: number;
  errors: number;
  durationMs: number;
  perEntity?: Array<{ table: string; field: string; count: number }>;
  /** First few errors for debugging — full list goes to Sentry. */
  sampleErrors?: string[];
  mode: EnrichMode;
};

function parseMode(raw: string | null): EnrichMode {
  if (raw === "refresh" || raw === "dryRun") return raw;
  return "new";
}

function parseLimit(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_ADDRESSES;
  const n = Number(raw);
  // 0 is technically valid input but means "do all the discovery + Hasura
  // work for zero enrichments". Treat as default rather than no-op-spend.
  if (n === 0) return DEFAULT_MAX_ADDRESSES;
  return Math.min(n, DEFAULT_MAX_ADDRESSES);
}

/**
 * Cron-triggered enrichment of Mento counterparty addresses with Arkham data.
 *
 * Auth: Bearer CRON_SECRET (cron path) OR an authenticated session
 * (manual trigger by an admin).
 *
 * Query params:
 * - `mode=new` (default) — only enrich addresses not yet labelled.
 * - `mode=refresh` — re-enrich addresses already tagged `arkham`. Use this
 *   monthly to pick up newly-attributed entities.
 * - `mode=dryRun` — fetch from Arkham but skip the Redis write.
 * - `limit=N` — hard cap on addresses processed (default 10000).
 */
// Vercel cron jobs invoke the configured path with a GET request, not POST.
// Exporting POST instead would 405 every scheduled run. The handler accepts
// no body — `mode` and `limit` are query params — so GET is the right verb.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronAuth(req, "arkham/enrich");
  if (authBail) return authBail;

  const apiKey = process.env.ARKHAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ARKHAM_API_KEY is not configured" },
      { status: 500 },
    );
  }
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
      "arkham-enrich",
      async () => {
        // Pre-flight: health check, address discovery, and existing-label
        // read have no data dependency on each other — run concurrently so
        // we don't pay 3× the round-trip latency before Arkham work begins.
        // `getAllLabels` reads BOTH global and chain scopes: importLabels'
        // Lua script HDELs the address from every other `labels:*` scope, so
        // a write to chain 42220 deletes the address from `labels:global` if
        // it lived there. Filtering against the global scope too prevents
        // silent loss of cross-chain manual labels.
        const [healthy, discovery, allLabels] = await Promise.all([
          fetchHealth(apiKey),
          discoverMentoAddresses(hasuraUrl, CELO_CHAIN_ID),
          getAllLabels(),
        ]);

        if (!healthy) {
          throw new Error("arkham_health_check_failed");
        }

        const { addresses, perEntity } = discovery;
        // Flatten every scope into one map for filtering. The strict
        // either/or invariant (an address lives in exactly one scope) means
        // there are no key collisions. We write to "global" but legacy rows
        // may still live in chain scopes — the importLabels Lua HDELs them
        // from those scopes when the global write happens, so they migrate
        // naturally on next refresh.
        const existing: Record<string, AddressEntry> = { ...allLabels.global };
        for (const chainEntries of Object.values(allLabels.chains)) {
          Object.assign(existing, chainEntries);
        }
        const filterMode = mode === "dryRun" ? "new" : mode;
        let candidates = filterCandidates(addresses, existing, filterMode);

        // Refresh-mode rotation: if the arkham-tagged set ever exceeds
        // `maxAddresses`, a deterministic alphabetical slice would re-process
        // the same prefix every month and never revisit the tail. Sort by
        // `updatedAt` ascending so the staler entries refresh first; the
        // post-write `updatedAt` rolls them to the end of the queue, giving
        // round-robin coverage across runs.
        if (mode === "refresh") {
          // Sort against `existing` (merged global + chain) so the rotation
          // matches the filter's view; using chain-only would mis-order if a
          // candidate happened to live in global scope.
          candidates = candidates.sort((a, b) => {
            const ua = existing[a]?.updatedAt ?? "";
            const ub = existing[b]?.updatedAt ?? "";
            return ua.localeCompare(ub);
          });
        }
        candidates = candidates.slice(0, maxAddresses);

        const results = await enrichBatch(candidates, { apiKey });

        const toWrite: Record<
          string,
          NonNullable<EnrichmentResult["entry"]>
        > = {};
        const errors: string[] = [];
        for (const r of results) {
          if (r.error) errors.push(`${r.address}: ${r.error}`);
          if (!r.entry) continue;
          // In refresh mode, preserve user-edited notes/isPublic + any tags
          // they added on top of a previous arkham write.
          toWrite[r.address] =
            mode === "refresh"
              ? mergeRefreshEntry(existing[r.address], r.entry)
              : r.entry;
        }

        if (mode !== "dryRun" && Object.keys(toWrite).length > 0) {
          // Write to global scope — Arkham's attribution is inherently
          // cross-chain (EVM addresses are chain-agnostic). The strict
          // either/or Lua script HDELs these addresses from chain scopes
          // if they were previously chain-scoped, migrating legacy rows
          // automatically.
          await importLabels("global", toWrite);
        }

        const enrichedCount = Object.keys(toWrite).length;
        const skippedCount = results.length - enrichedCount - errors.length;

        if (errors.length > 0) {
          // Tag in Sentry but don't fail the run — partial success is normal
          // (e.g. one 5xx during a 5k-address batch).
          Sentry.captureMessage(
            `[arkham/enrich] ${errors.length} errors during batch`,
            {
              tags: { route: "arkham/enrich", mode },
              extra: { errors: errors.slice(0, 50) },
              level: "warning",
            },
          );
        }

        const body: EnrichResponse = {
          ok: true,
          scope: "global",
          discoveryChainId: CELO_CHAIN_ID,
          discovered: addresses.length,
          candidates: candidates.length,
          enriched: enrichedCount,
          skipped: skippedCount,
          errors: errors.length,
          durationMs: Date.now() - startedAt,
          perEntity,
          sampleErrors: errors.slice(0, 5),
          mode,
        };
        return NextResponse.json(body);
      },
      {
        // Cron schedule mirrors vercel.json — keep them in sync.
        schedule: { type: "crontab", value: "0 4 * * *" },
        checkinMargin: 5,
        maxRuntime: 15,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "arkham/enrich", mode } });
    console.error("[arkham/enrich]", err);

    if (err instanceof ArkhamAuthError) {
      return NextResponse.json(
        { error: "Arkham API key rejected" },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Enrichment failed" }, { status: 500 });
  }
}
