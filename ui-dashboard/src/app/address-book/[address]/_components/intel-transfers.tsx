"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import { fetchJsonOr404 } from "@/lib/fetch-json";
import { relativeTimeFromIso, truncateAddress } from "@/lib/format";
import { Table, Row, Th, Td } from "@/components/table";
import { Pagination } from "@/components/pagination";
import type { IntelTransfersRecord } from "@/lib/intel-transfers";

const PAGE_SIZE = 50;

type Transfer = {
  id: string;
  blockTimestamp: string;
  fromAddress: { address: string };
  toAddress: { address: string };
  tokenSymbol?: string | null;
  unitValue?: number | null;
  historicalUSD?: number | null;
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
        {formatTransferUsd(tx.historicalUSD)}
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
  const [page, setPage] = useState(1);
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

  if (!data) return null;
  const transfers = (data.transfers ?? []) as Transfer[];
  if (transfers.length === 0) return null;

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
        {data.fetchedAt && (
          <span className="text-xs text-slate-500">
            Fetched {relativeTimeFromIso(data.fetchedAt)}
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
            onPageChange={setPage}
          />
        )}
      </div>
    </section>
  );
}
