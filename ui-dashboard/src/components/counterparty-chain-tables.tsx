"use client";

import Link from "next/link";
import { Table, Row, Th, Td } from "@/components/table";

type ArkhamAddressInfo = {
  address: string;
  arkhamLabel?: { name: string } | null;
  arkhamEntity?: { name: string } | null;
};

export type CounterpartyEntry = {
  address: ArkhamAddressInfo;
  flow: string;
  usd: number;
  /** Arkham entity for the counterparty (may be on address.arkhamEntity). */
  transactionCount: number;
};

type Props = {
  byChain: Record<string, CounterpartyEntry[]>;
};

const TOP_N = 10;

function cpName(entry: CounterpartyEntry): string {
  const addrInfo = entry.address;
  if (addrInfo.arkhamLabel?.name) return addrInfo.arkhamLabel.name;
  if (addrInfo.arkhamEntity?.name) return addrInfo.arkhamEntity.name;
  const addr = addrInfo.address;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUSD(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function CounterpartyChainTables({ byChain }: Props) {
  const chains = Object.keys(byChain).filter(
    (chain) => byChain[chain] && byChain[chain].length > 0,
  );
  if (chains.length === 0) return null;

  return (
    <div className="space-y-4">
      {chains.map((chain) => {
        const all = [...(byChain[chain] ?? [])].sort((a, b) => b.usd - a.usd);
        const visible = all.slice(0, TOP_N);
        const extra = all.length - visible.length;
        return (
          <div key={chain}>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              {chain}
            </p>
            <Table aria-label={`Counterparties on ${chain}`}>
              <thead>
                <Row>
                  <Th>Counterparty</Th>
                  <Th>Entity</Th>
                  <Th>Flow</Th>
                  <Th align="right">USD</Th>
                  <Th align="right">Txns</Th>
                </Row>
              </thead>
              <tbody>
                {visible.map((cp) => (
                  <Row key={`${cp.address.address}:${cp.flow}`}>
                    <Td>
                      <div className="flex flex-col">
                        <Link
                          href={`/address-book/${cp.address.address.toLowerCase()}`}
                          className="text-indigo-400 hover:text-indigo-300 hover:underline"
                        >
                          {cpName(cp)}
                        </Link>
                        <span className="font-mono text-[10px] text-slate-500">
                          {cp.address.address.slice(0, 6)}&hellip;
                          {cp.address.address.slice(-4)}
                        </span>
                      </div>
                    </Td>
                    <Td muted small>
                      {cp.address.arkhamEntity?.name ?? "—"}
                    </Td>
                    <Td small>
                      <span
                        className={
                          cp.flow === "in"
                            ? "text-emerald-400"
                            : cp.flow === "out"
                              ? "text-red-400"
                              : "text-slate-300"
                        }
                      >
                        {cp.flow}
                      </span>
                    </Td>
                    <Td align="right" mono small>
                      {formatUSD(cp.usd)}
                    </Td>
                    <Td align="right" mono small>
                      {cp.transactionCount.toLocaleString()}
                    </Td>
                  </Row>
                ))}
              </tbody>
            </Table>
            {extra > 0 && (
              <p className="mt-1 text-xs text-slate-500">+{extra} more</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
