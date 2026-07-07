import { AddressLink } from "@/components/address-link";
import { Row, Td } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import { explorerTxUrl } from "@/lib/tokens";
import type { CdpCollateral, CdpTrove } from "../../_lib/types";
import { formatTokenAmount } from "../../_lib/format";
import type { TroveDisplayRow } from "./trove-sort";

const D18 = BigInt(10) ** BigInt(18);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MENTO_APP_BORROW_MANAGE_BASE_URL = "https://app.mento.org/borrow/manage";

export type TroveRowView = "open" | "history";

export function TroveRow({
  row,
  collateral,
  view,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
  view: TroveRowView;
}) {
  if (view === "history") {
    return <HistoryTroveRow row={row} collateral={collateral} />;
  }
  return <OpenTroveRow row={row} collateral={collateral} />;
}

function OpenTroveRow({
  row,
  collateral,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
}) {
  const { trove } = row;
  const icrTimestamp = formatTimestamp(trove.lastUpdatedAt);
  const icrTitle =
    trove.icrBps < 0
      ? `Indexed ICR unavailable. Row last updated at ${icrTimestamp}.`
      : `Indexed ICR as of ${icrTimestamp}.\nNot a live RPC or oracle read.`;
  return (
    <Row>
      <Td align="right">
        <RankValue row={row} />
      </Td>
      <Td>
        <OwnerTroveCell trove={trove} collateral={collateral} />
      </Td>
      <Td>{trove.status}</Td>
      <Td align="right">{formatTokenAmount(trove.debt, collateral.symbol)}</Td>
      <Td align="right">{formatTokenAmount(trove.coll, "USDm")}</Td>
      <Td align="right">
        <Tooltip content={icrTitle} align="right">
          <span className={icrTextClass(trove.icrBps, collateral.mcrBps)}>
            {formatBpsPercent(trove.icrBps)}
          </span>
        </Tooltip>
      </Td>
      <Td align="right">
        <InterestValue row={row} />
      </Td>
      <Td align="right">
        <UpdatedValue trove={trove} chainId={collateral.chainId} />
      </Td>
    </Row>
  );
}

function HistoryTroveRow({
  row,
  collateral,
}: {
  row: TroveDisplayRow;
  collateral: CdpCollateral;
}) {
  const { trove } = row;
  const endedAt = trove.closedAt ?? trove.lastUpdatedAt;
  const endedTxHash = trove.closedTxHash ?? trove.lastUpdatedTxHash ?? null;
  return (
    <Row>
      <Td>
        <OwnerTroveCell trove={trove} collateral={collateral} useLastOwner />
      </Td>
      <Td>{trove.status}</Td>
      <Td align="right">
        <EventTimeValue
          timestamp={trove.openedAt}
          txHash={trove.openedTxHash}
          chainId={collateral.chainId}
          prefix="Opened at"
        />
      </Td>
      <Td align="right">
        <EventTimeValue
          timestamp={endedAt}
          txHash={endedTxHash}
          chainId={collateral.chainId}
          prefix={trove.closedAt == null ? "Updated at" : "Ended at"}
        />
      </Td>
      <Td align="right">{formatTokenAmount(trove.coll, "USDm")}</Td>
      <Td align="right">
        <RedeemedValue trove={trove} symbol={collateral.symbol} />
      </Td>
      <Td align="right">
        <OutcomeAmount value={trove.redemptionFeePaidCum} symbol="USDm" />
      </Td>
      <Td align="right">
        <LiquidatedValue trove={trove} symbol={collateral.symbol} />
      </Td>
    </Row>
  );
}

function OwnerTroveCell({
  trove,
  collateral,
  useLastOwner = false,
}: {
  trove: CdpTrove;
  collateral: CdpCollateral;
  useLastOwner?: boolean;
}) {
  const owner = useLastOwner ? lastOwnerAddress(trove) : trove.owner;
  return (
    <div className="flex flex-col gap-0.5">
      <AddressLink address={owner} chainId={collateral.chainId} />
      <a
        href={troveManageUrl(trove.troveId, collateral.symbol)}
        target="_blank"
        rel="noopener noreferrer"
        title={trove.troveId}
        aria-label={`Manage trove ${trove.troveId} in the Mento app`}
        className="font-mono text-[10px] text-muted hover:text-white hover:underline focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {shortenHex(trove.troveId)}
      </a>
    </div>
  );
}

/**
 * Middle-ellipsize a long hex string (trove uint256 id, tx hash) for display.
 * Trove IDs rendered in full blew the first column past the viewport; tx hashes
 * read in full are noise in screen-reader link names. Short, distinguishable
 * form; the full value stays in the link href / title.
 */
function shortenHex(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function RankValue({ row }: { row: TroveDisplayRow }) {
  if (row.rank == null) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>#{row.rank.toLocaleString()}</span>
      {row.tied && <span className="text-[10px] text-muted">tie</span>}
    </span>
  );
}

function InterestValue({ row }: { row: TroveDisplayRow }) {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatInterestRate(row.effectiveRate)}</span>
      {row.rateSource === "batch" && (
        <span className="text-[10px] text-muted">Batch</span>
      )}
      {row.rateSource == null && row.trove.interestBatchId != null && (
        <span className="text-[10px] text-amber-400">Batch missing</span>
      )}
    </span>
  );
}

function EventTimeValue({
  timestamp,
  txHash,
  chainId,
  prefix,
}: {
  timestamp: string | null | undefined;
  txHash: string | null | undefined;
  chainId: number;
  prefix: string;
}) {
  if (!timestamp || timestamp === "0") {
    return <span className="text-muted">—</span>;
  }

  const label = relativeTime(timestamp);
  const exact = formatTimestamp(timestamp);
  if (!txHash) {
    return (
      <Tooltip content={`${prefix} ${exact}.`} align="right">
        <span className="text-slate-300">{label}</span>
      </Tooltip>
    );
  }

  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  if (network == null) {
    return (
      <Tooltip
        content={`${prefix} ${exact}. Transaction: ${txHash}.`}
        align="right"
      >
        <span className="text-slate-300">{label}</span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={`${prefix} ${exact}. Opens transaction ${txHash}.`}
      align="right"
      asChild
    >
      <a
        href={explorerTxUrl(network, txHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-slate-300 transition-colors hover:text-indigo-300"
      >
        {label}
      </a>
    </Tooltip>
  );
}

function RedeemedValue({ trove, symbol }: { trove: CdpTrove; symbol: string }) {
  if (
    !isPositiveWei(trove.redeemedDebt) &&
    !isPositiveWei(trove.redeemedColl) &&
    trove.redemptionCount === 0
  ) {
    return <span className="text-muted">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatTokenAmount(trove.redeemedDebt, symbol)}</span>
      <span className="text-[10px] text-muted">
        {trove.redemptionCount.toLocaleString()}{" "}
        {trove.redemptionCount === 1 ? "event" : "events"}
      </span>
    </span>
  );
}

function OutcomeAmount({
  value,
  symbol,
}: {
  value: string | null | undefined;
  symbol: string;
}) {
  if (!isPositiveWei(value)) return <span className="text-muted">—</span>;
  return <span>{formatTokenAmount(value, symbol)}</span>;
}

function LiquidatedValue({
  trove,
  symbol,
}: {
  trove: CdpTrove;
  symbol: string;
}) {
  if (
    !isPositiveWei(trove.liquidatedDebt) &&
    !isPositiveWei(trove.liquidatedColl)
  ) {
    return <span className="text-muted">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatTokenAmount(trove.liquidatedDebt, symbol)}</span>
      {isPositiveWei(trove.liquidatedColl) && (
        <span className="text-[10px] text-muted">
          {formatTokenAmount(trove.liquidatedColl, "USDm")}
        </span>
      )}
    </span>
  );
}

function UpdatedValue({
  trove,
  chainId,
}: {
  trove: CdpTrove;
  chainId: number;
}) {
  const label = relativeTime(trove.lastUpdatedAt);
  const timestamp = formatTimestamp(trove.lastUpdatedAt);
  const networkId = networkIdForChainId(chainId);
  const network = networkId ? NETWORKS[networkId] : null;
  // Deliberately a plain link, not a Tooltip (unlike EventTimeValue on the
  // History tab): the relative time is already clickable, so the popover was
  // just noise. The exact timestamp + destination are exposed to assistive tech
  // via real sr-only text (a native title or aria-label on a non-interactive
  // span isn't reliably announced) and to sighted users via the title.
  if (trove.lastUpdatedTxHash && network != null) {
    return (
      <a
        href={explorerTxUrl(network, trove.lastUpdatedTxHash)}
        target="_blank"
        rel="noopener noreferrer"
        title={`Updated at ${timestamp}`}
        className="font-mono text-slate-300 transition-colors hover:text-indigo-300"
      >
        {label}
        <span className="sr-only">
          , updated at {timestamp}, opens transaction{" "}
          {shortenHex(trove.lastUpdatedTxHash)}
        </span>
      </a>
    );
  }

  // No linkable explorer for this chain: still disclose the tx hash in the
  // title when one exists (mirrors EventTimeValue's no-explorer fallback) so it
  // isn't silently dropped.
  const fallbackTitle = trove.lastUpdatedTxHash
    ? `Updated at ${timestamp} · tx ${trove.lastUpdatedTxHash}`
    : `Updated at ${timestamp}`;
  return (
    <span className="text-slate-300" title={fallbackTitle}>
      {label}
      <span className="sr-only">
        , updated at {timestamp}
        {trove.lastUpdatedTxHash
          ? `, tx ${shortenHex(trove.lastUpdatedTxHash)}`
          : ""}
      </span>
    </span>
  );
}

function troveManageUrl(troveId: string, tokenSymbol: string): string {
  return `${MENTO_APP_BORROW_MANAGE_BASE_URL}/${encodeURIComponent(
    troveId,
  )}?token=${encodeURIComponent(tokenSymbol)}`;
}

function lastOwnerAddress(trove: CdpTrove): string {
  if (isZeroAddress(trove.owner) && !isZeroAddress(trove.previousOwner)) {
    return trove.previousOwner;
  }
  return trove.owner;
}

function isZeroAddress(address: string | null | undefined): boolean {
  return address?.toLowerCase() === ZERO_ADDRESS;
}

function isPositiveWei(value: string | null | undefined): boolean {
  if (value == null) return false;
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

function formatInterestRate(rate: bigint | null): string {
  if (rate == null) return "—";
  if (rate === BigInt(0)) return "0.00%";
  const hundredths = (rate * BigInt(10_000)) / D18;
  if (hundredths === BigInt(0)) return "<0.01%";
  return `${(Number(hundredths) / 100).toFixed(2)}%`;
}

function formatBpsPercent(bps: number): string {
  if (bps < 0) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

function icrTextClass(icrBps: number, mcrBps: number): string {
  if (icrBps < 0 || mcrBps <= 0) return "text-muted";
  if (icrBps < mcrBps) return "text-rose-300";
  if (icrBps < Math.ceil(mcrBps * 1.2)) return "text-amber-300";
  return "text-emerald-300";
}
