import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import { getLabels, importLabels } from "@/lib/address-labels";
import {
  ARKHAM_TAG,
  ArkhamAuthError,
  enrichBatch,
  filterCandidates,
  fetchHealth,
  type EnrichmentResult,
} from "@/lib/arkham";
import { discoverMentoAddresses } from "@/lib/arkham-discovery";

// Vercel hobby/pro hard caps the per-invocation duration on `serverless` —
// a 5k-address run at 60ms spacing is ~5 minutes which fits in the 800s
// fluid-compute / 300s pro budget. `nodejs` is required (Edge runtime
// rejects long-running fetch loops + has no setTimeout pacer).
export const runtime = "nodejs";
export const maxDuration = 800;

const CELO_MAINNET_CHAIN_ID = 42220;

type EnrichResponse = {
  ok: boolean;
  chainId: number;
  discovered: number;
  candidates: number;
  enriched: number;
  skipped: number;
  errors: number;
  durationMs: number;
  /** Summary of which Hasura entity contributed how many addresses. */
  perEntity?: Array<{ table: string; field: string; count: number }>;
  /** First few errors for debugging — full list goes to Sentry. */
  sampleErrors?: string[];
  mode: "new" | "refresh" | "dryRun";
};

/**
 * Cron-triggered enrichment of Mento counterparty addresses with Arkham data.
 *
 * Auth: Bearer CRON_SECRET (cron path) OR an authenticated session
 * (manual trigger by an admin). Mirrors the existing
 * `/api/address-labels/backup` pattern.
 *
 * Query params:
 * - `mode=new` (default) — only enrich addresses not yet labelled.
 * - `mode=refresh` — re-enrich addresses already tagged `arkham`. Use this
 *   monthly to pick up newly-attributed entities.
 * - `mode=dryRun` — fetch from Arkham but skip the Redis write. Useful for
 *   smoke-testing the pipeline without committing labels.
 * - `limit=N` — hard cap on addresses processed (default 10000).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const apiKey = process.env.ARKHAM_API_KEY;
  const hasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL;
  const isDev = process.env.NODE_ENV === "development";

  // ── Auth ────────────────────────────────────────────────────────────────
  if (!isDev) {
    if (!cronSecret) {
      console.error("[arkham/enrich] CRON_SECRET is not set");
      return NextResponse.json(
        { error: "Server misconfiguration: CRON_SECRET required" },
        { status: 500 },
      );
    }
    const authHeader = req.headers.get("authorization");
    const isCronAuth = authHeader === `Bearer ${cronSecret}`;
    if (!isCronAuth) {
      const session = await getAuthSession();
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────
  if (!apiKey) {
    return NextResponse.json(
      { error: "ARKHAM_API_KEY is not configured" },
      { status: 500 },
    );
  }
  if (!hasuraUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_HASURA_URL is not configured" },
      { status: 500 },
    );
  }

  const modeParam = req.nextUrl.searchParams.get("mode");
  const mode: "new" | "refresh" | "dryRun" =
    modeParam === "refresh"
      ? "refresh"
      : modeParam === "dryRun"
        ? "dryRun"
        : "new";

  const limitParam = req.nextUrl.searchParams.get("limit");
  const maxAddresses = limitParam && /^\d+$/.test(limitParam)
    ? Math.min(Number(limitParam), 10_000)
    : 10_000;

  const startedAt = Date.now();

  try {
    return await Sentry.withMonitor(
      "arkham-enrich",
      async () => {
        // Cheap key + reachability check before kicking off the batch — fails
        // fast on misconfiguration rather than 401-ing every address in the
        // candidate set.
        const healthy = await fetchHealth(apiKey);
        if (!healthy) {
          throw new Error("arkham_health_check_failed");
        }

        // ── Discover candidate addresses ────────────────────────────────
        const { addresses, perEntity } = await discoverMentoAddresses(
          hasuraUrl,
          CELO_MAINNET_CHAIN_ID,
        );

        // ── Filter against existing labels ──────────────────────────────
        const existing = await getLabels(CELO_MAINNET_CHAIN_ID);
        const filterMode = mode === "dryRun" ? "new" : mode;
        const candidates = filterCandidates(
          addresses,
          existing,
          filterMode,
        ).slice(0, maxAddresses);

        // ── Hit Arkham, paced for the standard rate limit ───────────────
        const results = await enrichBatch(candidates, {
          apiKey,
          chain: "celo",
          maxAddresses,
        });

        // ── Persist successful enrichments ──────────────────────────────
        const toWrite: Record<string, EnrichmentResult["entry"]> = {};
        const errors: string[] = [];
        for (const r of results) {
          if (r.error) errors.push(`${r.address}: ${r.error}`);
          if (r.entry) toWrite[r.address] = r.entry;
        }

        if (mode !== "dryRun" && Object.keys(toWrite).length > 0) {
          // `importLabels` runs the same atomic Lua script as `upsertEntry`,
          // so it preserves the strict either/or invariant across scopes.
          // Cast keeps TS happy — `toWrite` filters out null entries above.
          await importLabels(
            CELO_MAINNET_CHAIN_ID,
            toWrite as Record<string, NonNullable<EnrichmentResult["entry"]>>,
          );
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
          chainId: CELO_MAINNET_CHAIN_ID,
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
    return NextResponse.json(
      { error: "Enrichment failed" },
      { status: 500 },
    );
  }
}
