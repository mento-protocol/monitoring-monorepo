"use client";

import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { Row, Table, Td, Th } from "@/components/table";
import { formatTimestamp } from "@/lib/format";
import { formatTokenAmount } from "../../../../_lib/format";
import { CDP_TROVES_DETAIL_LIMIT } from "../../../../_lib/types";
import { formatInterestRate } from "../_lib/format";
import {
  maxTroveQueueRungDebt,
  troveQueueBarWidthPercent,
  type TroveQueueReadyModel,
  type TroveQueueRung,
} from "../_lib/queue";
import type { TroveQueueState } from "../_lib/use-trove-queue";

const NOTICE_CLASSES = "mt-3 text-xs text-amber-400";

function QueueLoadingSkeleton() {
  return (
    <div
      className="mt-3 space-y-2"
      role="status"
      aria-live="polite"
      aria-label="Loading redemption queue"
    >
      <div className="h-3 w-full max-w-sm animate-pulse rounded bg-slate-800/50" />
      <div className="h-3 w-full animate-pulse rounded bg-slate-800/50" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-slate-800/50" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/50" />
    </div>
  );
}

/** This trove's relation to the queue, as one sentence. Positioned troves
 *  get rank + shield; everything else states honestly why there is no
 *  position — a zombie sits outside the sorted queue, a closed trove left
 *  it, and an active trove missing from the latest fetch (transient skew
 *  between the header and queue polls) is "unavailable", never guessed. */
function queueSummaryText(
  model: TroveQueueReadyModel,
  troveStatus: string,
  debtSymbol: string,
): string {
  const thisTrove = model.thisTrove;
  if (thisTrove != null) {
    const rankLine = `Current rate ${formatInterestRate(thisTrove.rate)} — queue position #${thisTrove.position} of ${thisTrove.rateLevels} rate levels.`;
    const shieldLine =
      BigInt(thisTrove.shieldDebt) > BigInt(0)
        ? `${formatTokenAmount(thisTrove.shieldDebt, debtSymbol)} of active debt at lower rates shields this trove today.`
        : "No lower-rate active debt shields this trove — it is redeemed first.";
    return `${rankLine} ${shieldLine}`;
  }
  if (troveStatus === "zombie") {
    return "This trove is a zombie — it sits outside the rate-ordered queue and holds no position until adjusted.";
  }
  if (troveStatus === "active") {
    return "This trove's queue position is unavailable — it was not in the latest active-trove fetch.";
  }
  return `This trove is ${troveStatus} — it is no longer in the redemption queue.`;
}

function QueueRungRow({
  rung,
  maxDebt,
  debtSymbol,
}: {
  rung: TroveQueueRung;
  maxDebt: string;
  debtSymbol: string;
}) {
  return (
    <Row className={rung.containsThisTrove ? "bg-indigo-500/10" : undefined}>
      <Td mono>{formatInterestRate(rung.rate)}</Td>
      <Td>
        <div className="flex items-center gap-2">
          {/* Decorative — the exact figure sits right next to it. */}
          <div
            aria-hidden="true"
            className="h-1.5 w-20 shrink-0 overflow-hidden rounded bg-slate-800 sm:w-32"
          >
            <div
              className="h-full rounded bg-indigo-400/70"
              style={{
                width: troveQueueBarWidthPercent(rung.debt, maxDebt),
                minWidth: "1px",
              }}
            />
          </div>
          <span className="whitespace-nowrap font-mono text-xs text-slate-300">
            {formatTokenAmount(rung.debt, debtSymbol)}
          </span>
        </div>
      </Td>
      <Td align="right" mono>
        {rung.containsThisTrove ? (
          <span className="text-indigo-300">#{rung.position} · this trove</span>
        ) : (
          <>#{rung.position}</>
        )}
      </Td>
    </Row>
  );
}

function QueueLadder({
  rungs,
  debtSymbol,
}: {
  rungs: TroveQueueRung[];
  debtSymbol: string;
}) {
  const maxDebt = maxTroveQueueRungDebt(rungs);
  return (
    <div className="mt-3 max-h-72 overflow-y-auto">
      <Table aria-label="Redemption queue ladder">
        <thead>
          <Row>
            <Th>Interest rate</Th>
            {/* One column spans the bar AND its figure — approved design. */}
            <Th>Debt at this rate</Th>
            <Th align="right">Queue position</Th>
          </Row>
        </thead>
        <tbody>
          {rungs.map((rung) => (
            <QueueRungRow
              key={rung.rate}
              rung={rung}
              maxDebt={maxDebt}
              debtSymbol={debtSymbol}
            />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function QueueReady({
  model,
  troveStatus,
  debtSymbol,
}: {
  model: TroveQueueReadyModel;
  troveStatus: string;
  debtSymbol: string;
}) {
  return (
    <>
      <p role="status" className="mt-3 text-xs text-slate-300">
        {queueSummaryText(model, troveStatus, debtSymbol)}
      </p>
      <QueueLadder rungs={model.rungs} debtSymbol={debtSymbol} />
      <p className="mt-2 text-xs text-slate-500">
        Bar length is proportional to the debt at each rate. Zombie troves sit
        outside the queue and shield nothing — though a leftover zombie trove
        (the market&apos;s <code>lastZombieTroveId</code> remnant) is redeemed
        first on the next redemption.
      </p>
    </>
  );
}

function QueuePanelBody({
  queue,
  troveStatus,
  debtSymbol,
}: {
  queue: TroveQueueState;
  troveStatus: string;
  debtSymbol: string;
}) {
  if (queue.error != null && !queue.hasLoadedOnce) {
    // First-load failure: the rest of the page keeps rendering; this panel
    // degrades alone. Retry is automatic — the shared SWR retry policy and
    // the 30s poll keep re-attempting.
    return (
      <div className="mt-3">
        <ErrorBox
          message={`Failed to load the redemption queue — ${queue.error.message}. Retrying automatically.`}
        />
      </div>
    );
  }
  if (queue.model == null) return <QueueLoadingSkeleton />;
  switch (queue.model.kind) {
    case "shutdown":
      return (
        <p
          role="status"
          className="mt-3 rounded border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
        >
          This market is shut down
          {queue.model.shutDownAt != null
            ? ` (since ${formatTimestamp(queue.model.shutDownAt)})`
            : ""}
          {" — "}redemptions are urgent-mode and no longer follow the rate
          queue, so rate order does not decide which troves are redeemed.
        </p>
      );
    case "capped":
      return (
        <p role="status" className={NOTICE_CLASSES}>
          Queue position and shield are hidden because the full open-trove set
          is not loaded — the fetch is capped at{" "}
          {CDP_TROVES_DETAIL_LIMIT.toLocaleString()} troves, and a partial
          ladder would misstate the queue.
        </p>
      );
    case "unresolved-rates":
      return (
        <p role="status" className={NOTICE_CLASSES}>
          Queue position and shield are unavailable —{" "}
          {queue.model.unresolvedCount === 1
            ? "an active trove carries"
            : `${queue.model.unresolvedCount.toLocaleString()} active troves carry`}{" "}
          a batch-managed rate the indexer has not resolved yet.
        </p>
      );
    case "empty":
      return (
        <div className="mt-3">
          <EmptyBox message="No active troves in this market — the redemption queue is empty." />
        </div>
      );
    case "ready":
      return (
        <QueueReady
          model={queue.model}
          troveStatus={troveStatus}
          debtSymbol={debtSymbol}
        />
      );
  }
}

/** "Why was my trove redeemed?" (docs/PLAN-trove-history-page.md,
 *  "UI design → Redemption queue"): the market's current rate ladder with
 *  this trove's dense queue position and the lower-rate debt shielding it.
 *  Current state only — historical rank is not tracked, and the panel says
 *  so. Rank/shield/ladder are suppressed entirely (never partially) when the
 *  open-trove fetch hits the row cap, and the whole ladder yields to a
 *  shutdown notice while the market's `isShutDown` flag is set. */
export function TroveRedemptionQueuePanel({
  queue,
  troveStatus,
  debtSymbol,
}: {
  queue: TroveQueueState;
  /** From the header's `Trove` row — drives the prose for troves that hold
   *  no queue position (zombie vs closed wording). */
  troveStatus: string;
  debtSymbol: string;
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-sm font-semibold text-white">Redemption queue</h2>
      <p className="mt-1 text-xs text-slate-500">
        Redemptions repay the lowest-rate active troves first. Historical rank
        is not tracked — the ladder shows the queue as of now.
      </p>
      <StaleRefreshNotice
        subject="Redemption queue"
        error={queue.hasLoadedOnce ? queue.error : undefined}
        className="mt-3"
      />
      <QueuePanelBody
        queue={queue}
        troveStatus={troveStatus}
        debtSymbol={debtSymbol}
      />
    </section>
  );
}
