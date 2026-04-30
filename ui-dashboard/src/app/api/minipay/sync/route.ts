import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireCronAuth } from "@/lib/cron-auth";
import {
  DuneAuthError,
  addToMiniPaySet,
  fetchMiniPayUsers,
  getLastSyncedBlock,
  getMiniPaySetSize,
  setLastSyncedBlock,
} from "@/lib/minipay";

// Vercel hobby/pro hard-caps the per-invocation duration on `serverless`. A
// full Dune backfill (~5M rows paginated) plus chunked SADD into Upstash
// fits comfortably under 800s on the first run; incremental runs are
// seconds-long. `nodejs` runtime needed for fetch + setTimeout pacing.
export const runtime = "nodejs";
export const maxDuration = 800;

type SyncResponse = {
  ok: boolean;
  /** Rows pulled from Dune this run (post-validation, post-dedup). */
  fetched: number;
  /** New SET members SADD'd. Equals `fetched` on first run; small delta after. */
  added: number;
  /** Total `SCARD minipay:users` after the run. */
  total: number;
  /** Highest block_number observed in the Dune result set. */
  maxBlock: string;
  /** Cursor before this run (lastBlock passed to Dune). */
  fromBlock: string;
  durationMs: number;
};

/**
 * Cron-triggered sync of the MiniPay user set from Dune to Redis.
 *
 * Auth: Bearer `CRON_SECRET`.
 *
 * Cursor semantics: persisted block (`minipay:lastBlock`) is the
 * **inclusive lower bound** for the next run's Dune query. Advancement only
 * happens after every page is SADD'd successfully — partial failure leaves
 * the cursor untouched so the next run re-pulls the missing rows.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authBail = await requireCronAuth(req, "minipay/sync");
  if (authBail) return authBail;

  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DUNE_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const startedAt = Date.now();

  try {
    return await Sentry.withMonitor(
      "minipay-sync",
      async () => {
        const fromBlock = await getLastSyncedBlock();

        const { addresses, maxBlock, count } = await fetchMiniPayUsers({
          apiKey,
          lastBlock: fromBlock,
        });

        // SADD before cursor advancement. If SADD throws partway, the
        // cursor stays at fromBlock so the next run re-pulls from there —
        // SADD is idempotent on existing members.
        const added = await addToMiniPaySet(addresses);

        // Cursor only advances when we actually saw rows. An empty result
        // set leaves it where it was so a transient Dune blank doesn't
        // strand us on a stale block.
        if (maxBlock > fromBlock) {
          await setLastSyncedBlock(maxBlock);
        }

        const total = await getMiniPaySetSize();
        const body: SyncResponse = {
          ok: true,
          fetched: count,
          added,
          total,
          maxBlock: maxBlock.toString(),
          fromBlock: fromBlock.toString(),
          durationMs: Date.now() - startedAt,
        };
        return NextResponse.json(body);
      },
      {
        // Cron schedule mirrors vercel.json — keep them in sync.
        schedule: { type: "crontab", value: "30 3 * * *" },
        checkinMargin: 5,
        maxRuntime: 15,
        timezone: "Etc/UTC",
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "minipay/sync" } });
    console.error("[minipay/sync]", err);

    if (err instanceof DuneAuthError) {
      return NextResponse.json(
        { error: "Dune API key rejected" },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
