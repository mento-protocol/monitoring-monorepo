import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireCronAuth } from "@/lib/cron-auth";
import {
  DuneAuthError,
  addToMiniPaySet,
  advanceLastSyncedBlock,
  fetchMiniPayUsers,
  getLastSyncedBlock,
  getMiniPaySetSize,
} from "@/lib/minipay";

// `nodejs` runtime needed for fetch + setTimeout pacing in the Dune client.
// 800s budget covers the first-run full backfill; incremental runs are seconds.
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
 * **exclusive lower bound** for the next run — Dune query 7404332 filters
 * `WHERE block_number > {{lastBlock}}`, so a row at exactly `lastBlock` is
 * not re-fetched. After a successful run we persist `maxBlock` (the highest
 * block we saw); the next run queries `block_number > maxBlock`, which
 * correctly skips the rows we already wrote without missing anything.
 *
 * Cursor advancement only happens after every page is SADD'd successfully —
 * partial failure leaves the cursor untouched so the next run re-pulls the
 * missing rows (SADD is idempotent on retry).
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

        // Stream Dune pages → SADD per page → advance cursor on success.
        // SADD is idempotent, so a mid-run failure leaves earlier pages
        // persisted in Redis; the cursor only advances after every page
        // is written, so the next run will re-pull from `fromBlock` and
        // SADD-no-op the already-stored pages before catching up.
        let fetched = 0;
        let added = 0;
        let maxBlock = fromBlock;
        for await (const page of fetchMiniPayUsers({
          apiKey,
          lastBlock: fromBlock,
        })) {
          fetched += page.addresses.length;
          added += await addToMiniPaySet(page.addresses);
          if (page.maxBlock > maxBlock) maxBlock = page.maxBlock;
        }

        if (maxBlock > fromBlock) {
          await advanceLastSyncedBlock(maxBlock);
        }

        const total = await getMiniPaySetSize();
        const body: SyncResponse = {
          ok: true,
          fetched,
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
