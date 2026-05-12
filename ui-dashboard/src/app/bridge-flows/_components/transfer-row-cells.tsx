"use client";

/**
 * Row-level cell sub-components for the bridge-flows transfers table. Purely
 * presentational: no query calls, no sort state. They receive typed props
 * and return JSX. `RouteCell` is consumed by `RouteDeliveryTile`; the
 * remaining helpers (Dash, TxPill, …) are file-private.
 *
 * `"use client"` is explicit because `AddressLink` mounts the
 * `AddressLabelEditor` dialog (`useState`/`useEffect`) and `BridgeRedeemPill`
 * is a click-driven CTA — running this module on the server would throw.
 */

import { ChainIcon } from "@/components/chain-icon";
import { AddressLink } from "@/components/address-link";
import {
  BridgeRedeemPill,
  type AddToast,
} from "@/components/bridge-redeem-cta";
import {
  deriveBridgeStatus,
  formatDurationShort,
  transferDeliveryDurationSec,
} from "@/lib/bridge-status";
import { relativeTime, formatTimestamp, truncateAddress } from "@/lib/format";
import { networkForChainId, tokenAddressForSymbol } from "@/lib/networks";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/tokens";
import { wormholescanUrl } from "@/lib/wormhole/urls";
import type { BridgeProvider, BridgeTransfer } from "@/lib/types";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function Dash() {
  return <span className="text-slate-600">{"—"}</span>;
}

/** Wraps children in a Wormholescan tx anchor when href is set. Keeps the
 * cell's typography — no blue link recolor on the content. */
export function WormholescanLink({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on Wormholescan"
      className="hover:text-indigo-300 transition-colors"
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Route / chain helpers
// ---------------------------------------------------------------------------

export function RouteCell({
  sourceChainId,
  destChainId,
}: {
  sourceChainId: number | null;
  destChainId: number | null;
}) {
  const src = networkForChainId(sourceChainId);
  const dst = networkForChainId(destChainId);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
      {src ? <ChainIcon network={src} size={14} /> : <Dash />}
      <span className="text-slate-500">{"→"}</span>
      {dst ? <ChainIcon network={dst} size={14} /> : <Dash />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Time / duration cells
// ---------------------------------------------------------------------------

export function TimeCell({
  ts,
  whUrl,
}: {
  ts: string | null;
  whUrl: string | null;
}) {
  const relative = ts ? relativeTime(ts) : "—";
  const precise = ts ? formatTimestamp(ts) : undefined;
  if (whUrl) {
    return (
      <a
        href={whUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={precise}
        className="text-slate-400 hover:text-indigo-300 transition-colors"
      >
        {relative}
      </a>
    );
  }
  return (
    <span className="text-slate-400" title={precise}>
      {relative}
    </span>
  );
}

export function DurationCell({ transfer }: { transfer: BridgeTransfer }) {
  const durationSec = transferDeliveryDurationSec(transfer);
  if (durationSec === null) {
    // Mirror the STUCK overlay: any non-terminal-delivered status is
    // "pending" from a duration perspective — including the client-side
    // STUCK overlay, which should still show "pending" rather than em-dash
    // (it's unfinished, not unknown). CANCELLED/FAILED are unreachable on
    // the bridge page today (no indexer handler writes them) but the
    // em-dash branch is kept for schema-level safety.
    const derived = deriveBridgeStatus(transfer);
    const pending =
      derived !== "DELIVERED" &&
      derived !== "CANCELLED" &&
      derived !== "FAILED";
    return (
      <td
        className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-slate-500 font-mono text-right whitespace-nowrap"
        title={
          pending
            ? "Not yet delivered"
            : "Delivery timestamp unavailable for this transfer"
        }
      >
        {pending ? "pending" : "—"}
      </td>
    );
  }
  return (
    <td
      className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-slate-400 font-mono text-right whitespace-nowrap"
      title="Source-send to destination-delivery elapsed time"
    >
      {formatDurationShort(durationSec)}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Token / address cells
// ---------------------------------------------------------------------------

export function TokenCell({
  symbol,
  chainId,
}: {
  symbol: string;
  chainId: number | null;
}) {
  // Resolve the per-chain token address from @mento-protocol/contracts via
  // the network's tokenSymbols map — NOT from the indexer-stored
  // BridgeTransfer.tokenAddress. The NTT hub/spoke model deploys a distinct
  // token address per chain, and legacy indexer data (pre-b390cc9) can carry
  // the destination-chain's address tagged with the source chain id, which
  // would produce broken cross-chain explorer links. Symbol + chainId is
  // authoritative and stable across indexer state.
  const net = networkForChainId(chainId);
  const address = net ? tokenAddressForSymbol(net, symbol) : null;
  if (!net || !address) {
    return <span className="font-mono text-slate-200">{symbol}</span>;
  }
  return (
    <a
      href={explorerAddressUrl(net, address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="font-mono text-slate-200 hover:text-indigo-300 transition-colors"
    >
      {symbol}
      <span className="ml-1 text-slate-600" aria-hidden="true">
        {"↗"}
      </span>
    </a>
  );
}

export function TransferSenderCell({
  sender,
  chainId,
}: {
  sender: string | null;
  chainId: number | null;
}) {
  if (!sender) return <Dash />;
  const net = networkForChainId(chainId);
  // `<div>` (not `<span>`) because AddressLink can render AddressLabelEditor,
  // which mounts a `<dialog>` — phrasing content can't contain flow content.
  return (
    <div className="inline-flex items-center gap-1.5">
      {net && <ChainIcon network={net} size={14} />}
      {chainId ? (
        <AddressLink address={sender} chainId={chainId} />
      ) : (
        <span className="font-mono text-xs text-slate-400">
          {truncateAddress(sender)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tx link cells
// ---------------------------------------------------------------------------

function TxPill({
  href,
  label,
  title,
}: {
  href: string;
  label: string;
  title: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex items-center gap-0.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
    >
      {label}
      <span aria-hidden="true" className="text-slate-600">
        {"↗"}
      </span>
    </a>
  );
}

export function TxLinks({
  provider,
  sentTxHash,
  sourceChainId,
  deliveredTxHash,
  destChainId,
  redeemProps,
  addToast,
}: {
  provider: BridgeProvider;
  sentTxHash: string | null;
  sourceChainId: number | null;
  deliveredTxHash: string | null;
  destChainId: number | null;
  redeemProps: {
    sentTxHash: string;
    destChainId: number;
    tokenSymbol: string;
  } | null;
  addToast: AddToast;
}) {
  const src = networkForChainId(sourceChainId);
  const dst = networkForChainId(destChainId);
  const pills: Array<{ href: string; label: string; title: string }> = [];
  if (sentTxHash && src) {
    pills.push({
      href: explorerTxUrl(src, sentTxHash),
      label: "src",
      title: `Source tx on ${src.label}`,
    });
  }
  if (deliveredTxHash && dst) {
    pills.push({
      href: explorerTxUrl(dst, deliveredTxHash),
      label: "dst",
      title: `Destination tx on ${dst.label}`,
    });
  }
  // Wormholescan only resolves by source tx hash or VAA ID; digest alone
  // 404s. Skip the pill when we don't have the source tx yet.
  if (provider === "WORMHOLE" && sentTxHash) {
    pills.push({
      href: wormholescanUrl(sentTxHash),
      label: "wh",
      title: "End-to-end trace on Wormholescan",
    });
  }
  if (pills.length === 0 && !redeemProps) return <Dash />;
  return (
    <span className="inline-flex items-center gap-1">
      {pills.map((p) => (
        <TxPill key={p.label} {...p} />
      ))}
      {redeemProps ? (
        <BridgeRedeemPill {...redeemProps} addToast={addToast} />
      ) : null}
    </span>
  );
}
