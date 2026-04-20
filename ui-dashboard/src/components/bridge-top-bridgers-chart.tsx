"use client";

import { useState } from "react";
import { AddressLink } from "@/components/address-link";
import { Skeleton, ErrorBox, EmptyBox } from "@/components/feedback";
import {
  TOP_BRIDGERS_DEFAULT,
  TOP_BRIDGERS_EXPANDED,
} from "@/lib/bridge-flows/layout";
import type { BridgeBridger } from "@/lib/types";

interface BridgeTopBridgersChartProps {
  bridgers: BridgeBridger[];
  isLoading: boolean;
  hasError: boolean;
}

/**
 * Ranked list of bridgers with a horizontal bar scaled to the top sender's
 * count. Plain DOM — no Plotly — since the visual is just a bar overlay on
 * a row; avoids the async Plotly chunk for a view this simple.
 *
 * `AddressLink` handles the per-chain explorer link; chain is inferred from
 * the first entry in `sourceChainsUsed` (JSON array of chainIds written by
 * the indexer when the bridger first appears on a chain).
 */
export function BridgeTopBridgersChart({
  bridgers,
  isLoading,
  hasError,
}: BridgeTopBridgersChartProps) {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? TOP_BRIDGERS_EXPANDED : TOP_BRIDGERS_DEFAULT;
  const rows = bridgers.slice(0, limit);
  const maxCount = rows[0]?.totalSentCount ?? 0;
  const hasMore = bridgers.length > TOP_BRIDGERS_DEFAULT;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm text-slate-400">Top bridgers</h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          all-time by transfer count
        </span>
      </div>

      {hasError ? (
        <ErrorBox message="Unable to load top bridgers." />
      ) : isLoading && bridgers.length === 0 ? (
        <Skeleton rows={6} />
      ) : bridgers.length === 0 ? (
        <EmptyBox message="No bridgers yet." />
      ) : (
        <>
          <ol className="space-y-2">
            {rows.map((b, i) => {
              const ratio = maxCount > 0 ? b.totalSentCount / maxCount : 0;
              const chainId = parseFirstChainId(b.sourceChainsUsed);
              return (
                <li
                  key={b.id}
                  className="relative overflow-hidden rounded border border-slate-800/60 bg-slate-800/30"
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-indigo-900/40"
                    style={{ width: `${Math.max(ratio * 100, 2)}%` }}
                  />
                  <div className="relative flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="w-5 text-right font-mono text-xs text-slate-500">
                        {i + 1}
                      </span>
                      {chainId ? (
                        <AddressLink address={b.sender} chainId={chainId} />
                      ) : (
                        <span className="font-mono text-xs text-slate-400">
                          {b.sender.slice(0, 6)}…{b.sender.slice(-4)}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-slate-300">
                      {b.totalSentCount.toLocaleString()}{" "}
                      <span className="text-slate-500">transfers</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          {hasMore && (
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {expanded
                  ? `Show top ${TOP_BRIDGERS_DEFAULT}`
                  : `Show top ${TOP_BRIDGERS_EXPANDED}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function parseFirstChainId(json: string): number | null {
  // Defense-in-depth: the indexer's `appendJsonSet` already wraps its
  // JSON.parse in try/catch and emits a safe fallback, so this should
  // never throw. We keep the symmetric guard so a single mangled row
  // from any future drift can't crash the whole chart during render.
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  const n = typeof first === "number" ? first : Number(first);
  return Number.isFinite(n) ? n : null;
}
