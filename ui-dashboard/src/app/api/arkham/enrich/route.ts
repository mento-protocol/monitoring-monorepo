import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  getLabel,
  getLabels,
  importArkhamRefreshLabelsIfUnchanged,
  importLabelsIfAbsent,
} from "@/lib/address-labels";
import { isArkhamSourced } from "@/lib/address-labels-shared";
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
const LABEL_READ_CONCURRENCY = 16;

type EnrichMode = "new" | "refresh" | "dryRun";

type EnrichResponse = {
  ok: boolean;
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

type EnrichWriteSet = Record<string, NonNullable<EnrichmentResult["entry"]>>;
type BuildLabelWritesResult = {
  toWrite: EnrichWriteSet;
  expectedUpdatedAt: Record<string, string>;
  errors: string[];
};
type EnrichWriteCandidate =
  | {
      status: "write";
      address: string;
      entry: NonNullable<EnrichmentResult["entry"]>;
      expectedUpdatedAt?: string;
    }
  | { status: "skip" }
  | { status: "error"; error: string };

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

async function buildLabelWrites(
  results: EnrichmentResult[],
  mode: EnrichMode,
): Promise<BuildLabelWritesResult> {
  const toWrite: EnrichWriteSet = {};
  const expectedUpdatedAt: Record<string, string> = {};
  const candidates = await runWithConcurrency(
    results,
    LABEL_READ_CONCURRENCY,
    (result) => buildWriteCandidate(result, mode),
  );
  const errors = candidates.flatMap((candidate) =>
    candidate.status === "error" ? [candidate.error] : [],
  );
  for (const candidate of candidates) {
    if (candidate.status === "write") {
      const lower = candidate.address.toLowerCase();
      toWrite[lower] = candidate.entry;
      if (candidate.expectedUpdatedAt !== undefined) {
        expectedUpdatedAt[lower] = candidate.expectedUpdatedAt;
      }
    }
  }
  return { toWrite, expectedUpdatedAt, errors };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  const runNext = (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= items.length) return Promise.resolve();

    const item = items[index];
    if (item === undefined) return runNext();

    return fn(item).then((result) => {
      results[index] = result;
      return runNext();
    });
  };

  const workers = Array.from({ length: workerCount }, runNext);

  await Promise.all(workers);
  return results;
}

async function buildWriteCandidate(
  result: EnrichmentResult,
  mode: EnrichMode,
): Promise<EnrichWriteCandidate> {
  if (result.error) {
    return { status: "error", error: `${result.address}: ${result.error}` };
  }
  if (!result.entry) return { status: "skip" };
  if (mode === "dryRun") {
    return { status: "write", address: result.address, entry: result.entry };
  }

  let latest: Awaited<ReturnType<typeof getLabel>>;
  try {
    latest = await getLabel(result.address);
  } catch (err) {
    return {
      status: "error",
      error: `${result.address}: getLabel failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (mode === "refresh") {
    if (!latest || !isArkhamSourced(latest)) return { status: "skip" };
    // Preserve edits made after the initial candidate snapshot but before
    // this long-running Arkham batch finished.
    return {
      status: "write",
      address: result.address,
      entry: mergeRefreshEntry(latest, result.entry),
      expectedUpdatedAt: latest.updatedAt,
    };
  }
  return latest
    ? { status: "skip" }
    : { status: "write", address: result.address, entry: result.entry };
}

async function writeEnrichmentLabels(
  mode: EnrichMode,
  writes: BuildLabelWritesResult,
): Promise<number> {
  const attempted = Object.keys(writes.toWrite).length;
  if (mode === "dryRun" || attempted === 0) return attempted;

  // Single labels hash — Arkham's attribution is inherently cross-chain
  // (EVM addresses are chain-agnostic), which matches the address-keyed model.
  return mode === "refresh"
    ? await importArkhamRefreshLabelsIfUnchanged(
        writes.toWrite,
        writes.expectedUpdatedAt,
      )
    : await importLabelsIfAbsent(writes.toWrite);
}

/**
 * Cron-triggered enrichment of Mento counterparty addresses with Arkham data.
 *
 * Auth: Bearer `CRON_SECRET`. This is a GET route with expensive side
 * effects, so session-only auth is intentionally rejected by `requireCronAuth`
 * to avoid CSRF-triggered enrichment runs.
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
        const [healthy, discovery, existing] = await Promise.all([
          fetchHealth(apiKey),
          discoverMentoAddresses(hasuraUrl, CELO_CHAIN_ID),
          getLabels(),
        ]);

        if (!healthy) {
          throw new Error("arkham_health_check_failed");
        }

        const { addresses, perEntity } = discovery;
        const filterMode = mode === "dryRun" ? "new" : mode;
        let candidates = filterCandidates(addresses, existing, filterMode);

        // Refresh-mode rotation: if the arkham-tagged set ever exceeds
        // `maxAddresses`, a deterministic alphabetical slice would re-process
        // the same prefix every month and never revisit the tail. Sort by
        // `updatedAt` ascending so the staler entries refresh first; the
        // post-write `updatedAt` rolls them to the end of the queue, giving
        // round-robin coverage across runs.
        if (mode === "refresh") {
          candidates = candidates.sort((a, b) => {
            const ua = existing[a]?.updatedAt ?? "";
            const ub = existing[b]?.updatedAt ?? "";
            return ua.localeCompare(ub);
          });
        }
        candidates = candidates.slice(0, maxAddresses);

        const results = await enrichBatch(candidates, { apiKey });
        const writes = await buildLabelWrites(results, mode);
        const { errors } = writes;
        const enrichedCount = await writeEnrichmentLabels(mode, writes);
        // In write modes this is based on actual atomic writes, so concurrent
        // inserts/edits that beat our compare-and-set are counted as skipped.
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
