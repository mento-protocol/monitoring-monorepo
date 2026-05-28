"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import { fetchJsonOr404 } from "@/lib/fetch-json";
import { relativeTimeFromIso, truncateAddress } from "@/lib/format";
import { Table, Row, Th, Td } from "@/components/table";
import { Pagination } from "@/components/pagination";
import type { IntelTransfersRecord } from "@/lib/intel-transfers";

const PAGE_SIZE = 50;

function readPageFromParams(params: URLSearchParams): number {
  const raw = params.get("page");
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function writePageToUrl(next: number): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (next <= 1) params.delete("page");
  else params.set("page", String(next));
  const qs = params.toString();
  const nextUrl =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

type Transfer = {
  id: string;
  blockTimestamp: string;
  fromAddress: { address: string };
  toAddress: { address: string };
  tokenSymbol?: string | null;
  unitValue?: number | null;
  usd?: number | null;
  chain: string;
  transactionHash: string;
};

// Arkham chain names → block-explorer tx URL prefix. The chain field on each
// transfer carries the slug Arkham uses (matches /transfers response shape).
const EXPLORER_URLS: Record<string, string> = {
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  bsc: "https://bscscan.com/tx/",
  polygon: "https://polygonscan.com/tx/",
  arbitrum_one: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  avalanche: "https://snowtrace.io/tx/",
};

function txLink(hash: string, chain: string): string | null {
  const base = EXPLORER_URLS[chain];
  return base ? `${base}${hash}` : null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTransferUsd(usd: number | null | undefined): string {
  if (usd == null || usd <= 0) return "—";
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function TransferRow({ tx, isIn }: { tx: Transfer; isIn: boolean }) {
  const counterparty = isIn ? tx.fromAddress.address : tx.toAddress.address;
  const sym = tx.tokenSymbol ?? "?";
  const link = txLink(tx.transactionHash, tx.chain);
  const shortHash = `${tx.transactionHash.slice(0, 6)}…${tx.transactionHash.slice(-4)}`;
  return (
    <Row>
      <Td small muted>
        {formatDate(tx.blockTimestamp)}
      </Td>
      <Td small>
        <span className={isIn ? "text-emerald-400" : "text-red-400"}>
          {isIn ? "in" : "out"}
        </span>
      </Td>
      <Td small>
        <Link
          href={`/address-book/${counterparty.toLowerCase()}`}
          className="font-mono text-indigo-400 hover:text-indigo-300 hover:underline"
        >
          {truncateAddress(counterparty)}
        </Link>
      </Td>
      <Td small mono>
        {sym}
      </Td>
      <Td align="right" small mono>
        {tx.unitValue != null ? `${tx.unitValue.toLocaleString()} ${sym}` : "—"}
      </Td>
      <Td align="right" small mono>
        {formatTransferUsd(tx.usd)}
      </Td>
      <Td small muted>
        {tx.chain}
      </Td>
      <Td small mono>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:text-indigo-300 hover:underline"
          >
            {shortHash}
          </a>
        ) : (
          shortHash
        )}
      </Td>
    </Row>
  );
}

export function IntelTransfers({ address }: { address: string }) {
  const { status } = useSession();
  // `useSearchParams` is used only for the SSR-pass fallback. The root layout
  // already wraps the tree in <Suspense> (`app/layout.tsx:56`), satisfying the
  // rule transitively — the static check just can't see across files.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const [page, setPage] = useState<number>(() => {
    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : searchParams;
    return readPageFromParams(params);
  });

  const updatePage = useCallback((next: number) => {
    setPage(next);
    writePageToUrl(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setPage((prev) => {
        const next = readPageFromParams(params);
        return prev === next ? prev : next;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const { data } = useSWR<IntelTransfersRecord | null>(
    status === "authenticated" ? `/api/intel/transfers/${address}` : null,
    (url: string) =>
      fetchJsonOr404<IntelTransfersRecord>(url, "Transfers", {
        timeoutMs: 15_000,
      }),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
    },
  );

  // Canonicalize the URL after data lands. Deep links like `?page=999`
  // (out of range), `?page=foo` (malformed), or `?page=1` (default)
  // otherwise render the clamped page but leave the stale param in the
  // address bar, so refresh / share don't reproduce the visible state.
  // Pattern mirrors `use-table-sort.ts:156-174` (sort) and the bridge-
  // flows pager's `page=1` URL-clearing test. We don't touch `page`
  // state — the rendered value is `clampedPage` derived per-render, so a
  // transient state.page > totalPages is harmless until the next user
  // action re-syncs via `updatePage` (avoids `effect/no-derived-state`
  // which fires when a useEffect writes state derivable in render).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!data) return;
    const list = (data.transfers ?? []) as Transfer[];
    if (list.length === 0) return;
    const total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const clamped = Math.max(1, Math.min(page, total));
    const params = new URLSearchParams(window.location.search);
    const rawPage = params.get("page");
    const expected = clamped <= 1 ? null : String(clamped);
    if (rawPage === expected) return;
    writePageToUrl(clamped);
  }, [data, page]);

  if (!data) return null;
  const transfers = (data.transfers ?? []) as Transfer[];
  if (transfers.length === 0) return null;
  return (
    <TransfersPanel
      address={address}
      fetchedAt={data.fetchedAt ?? null}
      transfers={transfers}
      page={page}
      onPageChange={updatePage}
    />
  );
}

function TransfersPanel({
  address,
  fetchedAt,
  transfers,
  page,
  onPageChange,
}: {
  address: string;
  fetchedAt: string | null;
  transfers: Transfer[];
  page: number;
  onPageChange: (next: number) => void;
}) {
  const sorted = [...transfers].sort(
    (a, b) =>
      new Date(b.blockTimestamp).getTime() -
      new Date(a.blockTimestamp).getTime(),
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const visible = sorted.slice(
    (clampedPage - 1) * PAGE_SIZE,
    clampedPage * PAGE_SIZE,
  );
  const addrLower = address.toLowerCase();
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-5 py-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Recent transfers</h2>
        {fetchedAt && (
          <span className="text-xs text-slate-500">
            Fetched {relativeTimeFromIso(fetchedAt)}
          </span>
        )}
      </div>
      <div className="p-5">
        <Table>
          <thead>
            <Row>
              <Th>Date</Th>
              <Th>Dir</Th>
              <Th>Counterparty</Th>
              <Th>Token</Th>
              <Th align="right">Amount</Th>
              <Th align="right">USD</Th>
              <Th>Chain</Th>
              <Th>Tx</Th>
            </Row>
          </thead>
          <tbody>
            {visible.map((tx) => (
              <TransferRow
                key={tx.id}
                tx={tx}
                isIn={tx.toAddress.address.toLowerCase() === addrLower}
              />
            ))}
          </tbody>
        </Table>
        {sorted.length > PAGE_SIZE && (
          <Pagination
            page={clampedPage}
            pageSize={PAGE_SIZE}
            total={sorted.length}
            onPageChange={onPageChange}
          />
        )}
      </div>
    </section>
  );
}
