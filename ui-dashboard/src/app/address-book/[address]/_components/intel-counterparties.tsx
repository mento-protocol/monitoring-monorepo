"use client";

import useSWR from "swr";
import { useSession } from "next-auth/react";
import { fetchJsonOr404 } from "@/lib/fetch-json";
import { relativeTimeFromIso } from "@/lib/format";
import {
  CounterpartyChainTables,
  type CounterpartyEntry,
} from "@/components/counterparty-chain-tables";
import type { IntelDeepRecord } from "@/lib/intel-deep";

export function IntelCounterparties({ address }: { address: string }) {
  const { status } = useSession();
  const { data } = useSWR<IntelDeepRecord | null>(
    status === "authenticated" ? `/api/intel/deep/${address}` : null,
    (url: string) =>
      fetchJsonOr404<IntelDeepRecord>(url, "Counterparties", {
        timeoutMs: 15_000,
      }),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
    },
  );

  if (!data) return null;

  const byChain = data.counterparties as
    | Record<string, CounterpartyEntry[]>
    | null
    | undefined;
  if (!byChain) return null;

  const chains = Object.keys(byChain).filter(
    (c) => (byChain[c]?.length ?? 0) > 0,
  );
  if (chains.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-5 py-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">
          Counterparties (30d)
        </h2>
        {data.fetchedAt && (
          <span className="text-xs text-slate-500">
            Fetched {relativeTimeFromIso(data.fetchedAt)}
          </span>
        )}
      </div>
      <div className="p-5">
        <CounterpartyChainTables byChain={byChain} />
      </div>
    </section>
  );
}
