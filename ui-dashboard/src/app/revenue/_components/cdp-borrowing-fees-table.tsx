import type { ReactNode } from "react";
import { Row, Table, Td, Th } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import type { CdpBorrowingRevenueMarket } from "@/lib/cdp-borrowing-revenue";
import { formatUSD } from "@/lib/format";

// Table fee columns are GROSS (borrower-side fees, before the SP yield
// split); the summary tile headlines the protocol's share. Tooltips call
// this out so the two surfaces don't read as contradictory.
const CDP_BORROWING_HEADER_INFO = {
  debt: "Active CDP debt, priced to USD from the debt token's live oracle rate.",
  runRate:
    "Annualized gross interest if current debt and rates stay unchanged, before the SP yield split.",
  upfront:
    "Cumulative one-time borrowing fees paid when troves are opened or debt is increased (gross, before the SP yield split).",
  interest:
    "Accrued interest so far, including live accrual since the last indexer update (gross, before the SP yield split).",
} as const;

const bpsToPercentLabel = (bps: number): string => {
  const pct = bps / 100;
  return Number.isInteger(pct)
    ? String(pct)
    : String(Math.round(pct * 100) / 100);
};

// The split is governance-set on-chain per market (SystemParams.SP_YIELD_SPLIT,
// indexed as LiquityCollateral.spYieldSplitBps and surfaced per market row),
// so the tooltip states the live values instead of hardcoding 25/75. Falls
// back to generic wording when markets disagree or the indexer hasn't loaded
// the param yet (-1 sentinel).
function cdpBorrowingTotalTooltip(
  markets: ReadonlyArray<CdpBorrowingRevenueMarket>,
): string {
  const splits = [...new Set(markets.map((m) => m.spYieldSplitBps))];
  const bps =
    splits.length === 1 &&
    splits[0] !== undefined &&
    splits[0] >= 0 &&
    splits[0] <= 10_000
      ? splits[0]
      : null;
  if (bps === null) {
    return "Gross borrowing fees (upfront + accrued interest), paid by borrowers. The protocol keeps the share shown in the summary tile; the rest is Stability Pool depositor yield.";
  }
  return `Gross borrowing fees (upfront + accrued interest), paid by borrowers. Split: ${bpsToPercentLabel(10_000 - bps)}% protocol treasury, ${bpsToPercentLabel(bps)}% Stability Pool depositor yield.`;
}

const CDP_AVERAGE_APR_INFO = (
  <span className="block space-y-1.5">
    <span className="block">
      Debt-weighted average APR on active debt. Larger troves count more than
      smaller troves.
    </span>
    <span className="block rounded border border-slate-700/70 bg-slate-950/70 px-2 py-1">
      <span className="font-sans text-muted">Formula: </span>
      <span className="font-mono text-slate-100">Σ(debt × APR) / Σ(debt)</span>
    </span>
  </span>
);

function MarketFeeCell({
  value,
  approximate,
  title,
}: {
  value: number;
  approximate: boolean;
  title: string | undefined;
}) {
  return (
    <Td mono align="right" className="sm:!px-2" {...(title ? { title } : {})}>
      {approximate ? "≈ " : ""}
      {formatUSD(value)}
    </Td>
  );
}

function MarketPercentCell({
  value,
  title,
}: {
  value: number | null;
  title: string | undefined;
}) {
  return (
    <Td mono align="right" className="sm:!px-2" {...(title ? { title } : {})}>
      {formatAnnualInterestRatePercent(value)}
    </Td>
  );
}

function formatAnnualInterestRatePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) < 10 ? 2 : 1;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")}%`;
}

function marketApproxTitle(
  market: CdpBorrowingRevenueMarket,
): string | undefined {
  if (market.bracketsTruncated) {
    return "Interest brackets exceeded the pagination cap; totals are a lower bound.";
  }
  if (market.unpricedSymbols.length > 0) {
    return `Unpriced debt token${market.unpricedSymbols.length === 1 ? "" : "s"}: ${market.unpricedSymbols.join(", ")}`;
  }
  return undefined;
}

function RevenueTableShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
      {children}
    </div>
  );
}

function CdpBorrowingHeaderInfo({
  label,
  content,
  tooltipAlign = "left",
}: {
  label: string;
  content: ReactNode;
  tooltipAlign?: "left" | "right";
}) {
  return (
    <Tooltip label={`About ${label}`} content={content} align={tooltipAlign}>
      {label}
    </Tooltip>
  );
}

function CdpBorrowingFeesMarketRow({
  market,
}: {
  market: CdpBorrowingRevenueMarket;
}) {
  const title = marketApproxTitle(market);
  const approximate = title !== undefined;
  return (
    <Row>
      <Td
        className="w-12 whitespace-nowrap sm:!pl-2 sm:!pr-1"
        title={`${market.activeTroveCount.toLocaleString()} active trove${market.activeTroveCount === 1 ? "" : "s"}`}
      >
        <span className="font-semibold text-sm text-slate-100">
          {market.symbol}
        </span>
      </Td>
      <MarketFeeCell
        value={market.activeDebtUSD}
        approximate={approximate}
        title={title}
      />
      <MarketPercentCell
        value={market.averageAnnualInterestRatePercent}
        title={title}
      />
      <MarketFeeCell
        value={market.annualInterestRunRateUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.upfrontFeesUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.accruedInterestUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.totalRevenueUSD}
        approximate={approximate}
        title={title}
      />
    </Row>
  );
}

export function CdpBorrowingFeesByMarketTable({
  markets,
  isLoading,
  hasError,
}: {
  markets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  isLoading: boolean;
  hasError: boolean;
}) {
  if (markets.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">
          Borrowing Fees by CDP
        </h2>
        <RevenueTableShell>
          {isLoading
            ? "Loading…"
            : hasError
              ? "Couldn't load CDP borrowing revenue."
              : "No CDP borrowing revenue indexed yet."}
        </RevenueTableShell>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-white">
        Borrowing Fees by CDP
      </h2>
      {hasError ? (
        <p className="mb-3 text-xs text-amber-400/80">
          One or more CDP markets failed to load — showing partial data.
        </p>
      ) : null}
      <Table aria-label="Borrowing fees by CDP market">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th className="w-12 sm:!pl-2 sm:!pr-1">CDP</Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Debt"
                content={CDP_BORROWING_HEADER_INFO.debt}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="ø APR"
                content={CDP_AVERAGE_APR_INFO}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Run/yr"
                content={CDP_BORROWING_HEADER_INFO.runRate}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Upfront"
                content={CDP_BORROWING_HEADER_INFO.upfront}
                tooltipAlign="right"
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Interest"
                content={CDP_BORROWING_HEADER_INFO.interest}
                tooltipAlign="right"
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="All-time"
                content={cdpBorrowingTotalTooltip(markets)}
                tooltipAlign="right"
              />
            </Th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <CdpBorrowingFeesMarketRow
              key={market.collateralId}
              market={market}
            />
          ))}
        </tbody>
      </Table>
    </section>
  );
}
