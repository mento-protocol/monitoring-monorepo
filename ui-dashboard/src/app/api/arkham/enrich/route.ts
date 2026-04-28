import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { chainSlug } from "@mento-protocol/monitoring-config/chains";
import { getLabels, importLabels } from "@/lib/address-labels";
import {
  ArkhamAuthError,
  enrichBatch,
  filterCandidates,
  fetchHealth,
  type EnrichmentResult,
} from "@/lib/arkham";
import { discoverMentoAddresses } from "@/lib/arkham-discovery";
import { requireCronOrSession } from "@/lib/cron-auth";
import { NETWORKS } from "@/lib/networks";

// Vercel hobby/pro hard caps the per-invocation duration on `serverless` —
// a 5k-address run at 60ms spacing is ~5 minutes which fits in the 800s
// fluid-compute / 300s pro budget. `nodejs` is required (Edge runtime
// rejects long-running fetch loops + has no setTimeout pacer).
export const runtime = "nodejs";
export const maxDuration = 800;

const CELO_CHAIN_ID = NETWORKS["celo-mainnet"].chainId;
const ARKHAM_CHAIN = chainSlug(CELO_CHAIN_ID);
const DEFAULT_MAX_ADDRESSES = 10_000;

type EnrichMode = "new" | "refresh" | "dryRun";

type EnrichResponse = {
  ok: boolean;
  chainId: number;
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
  return Math.min(Number(raw), DEFAULT_MAX_ADDRESSES);
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
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronOrSession(req, "arkham/enrich");
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
        const [healthy, discovery, existing] = await Promise.all([
          fetchHealth(apiKey),
          discoverMentoAddresses(hasuraUrl, CELO_CHAIN_ID),
          getLabels(CELO_CHAIN_ID),
        ]);

        if (!healthy) {
          throw new Error("arkham_health_check_failed");
        }

        const { addresses, perEntity } = discovery;
        const filterMode = mode === "dryRun" ? "new" : mode;
        const candidates = filterCandidates(
          addresses,
          existing,
          filterMode,
        ).slice(0, maxAddresses);

        const results = await enrichBatch(candidates, {
          apiKey,
          chain: ARKHAM_CHAIN,
        });

        const toWrite: Record<
          string,
          NonNullable<EnrichmentResult["entry"]>
        > = {};
        const errors: string[] = [];
        for (const r of results) {
          if (r.error) errors.push(`${r.address}: ${r.error}`);
          if (r.entry) toWrite[r.address] = r.entry;
        }

        if (mode !== "dryRun" && Object.keys(toWrite).length > 0) {
          await importLabels(CELO_CHAIN_ID, toWrite);
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
          chainId: CELO_CHAIN_ID,
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
