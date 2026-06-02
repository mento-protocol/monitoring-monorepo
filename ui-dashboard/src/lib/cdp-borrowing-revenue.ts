import { parseWei } from "./format";
import { tokenToUSD, type OracleRateMap } from "./tokens";

const ZERO = BigInt(0);
const D18 = BigInt(10) ** BigInt(18);
const ONE_YEAR_SECONDS = BigInt(31_536_000);

export type CdpBorrowingRevenueCollateral = {
  id: string;
  chainId: number;
  collIndex: number;
  symbol: string;
};

export type CdpBorrowingRevenueInstance = {
  id: string;
  collateralId: string;
  chainId: number;
  borrowingFeeCum: string;
};

export type CdpBorrowingRevenueBracket = {
  id: string;
  collateralId: string;
  rate: string;
  totalDebt: string;
  sumDebtTimesRateD36: string;
  pendingDebtTimesOneYearD36: string;
  updatedAt: string;
};

export type CdpBorrowingRevenueSummary = {
  totalRevenueUSD: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  annualizedInterestUSD: number;
  marketCount: number;
  activeInterestBracketCount: number;
  unpricedSymbols: string[];
  bracketsTruncated: boolean;
};

type AggregateArgs = {
  collaterals: ReadonlyArray<CdpBorrowingRevenueCollateral>;
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>;
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
  rates: OracleRateMap;
  nowSeconds?: number;
  bracketsTruncated?: boolean;
};

function accruedInterestWei(
  bracket: Pick<
    CdpBorrowingRevenueBracket,
    "pendingDebtTimesOneYearD36" | "sumDebtTimesRateD36" | "updatedAt"
  >,
  nowSeconds: number,
): bigint {
  const pendingDebtTimesOneYearD36 = BigInt(bracket.pendingDebtTimesOneYearD36);
  const sumDebtTimesRateD36 = BigInt(bracket.sumDebtTimesRateD36);
  const updatedAt = BigInt(bracket.updatedAt);
  const now = BigInt(Math.max(0, Math.floor(nowSeconds)));
  const elapsed = now > updatedAt ? now - updatedAt : ZERO;
  return (
    (pendingDebtTimesOneYearD36 + sumDebtTimesRateD36 * elapsed) /
    ONE_YEAR_SECONDS /
    D18
  );
}

function annualizedInterestWei(
  bracket: Pick<CdpBorrowingRevenueBracket, "sumDebtTimesRateD36">,
): bigint {
  return BigInt(bracket.sumDebtTimesRateD36) / D18;
}

function weiToTokenUSD(
  symbol: string,
  wei: bigint,
  rates: OracleRateMap,
): number | null {
  if (wei <= ZERO) return 0;
  return tokenToUSD(symbol, parseWei(wei.toString(), 18), rates);
}

export function aggregateCdpBorrowingRevenue({
  collaterals,
  instances,
  brackets,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  bracketsTruncated = false,
}: AggregateArgs): CdpBorrowingRevenueSummary {
  const symbolByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.symbol]),
  );
  const unpricedSymbols = new Set<string>();
  let upfrontFeesUSD = 0;
  let accruedInterestUSD = 0;
  let annualizedInterestUSD = 0;
  let activeInterestBracketCount = 0;

  const addPricedWei = (symbol: string | undefined, wei: bigint): number => {
    if (wei <= ZERO) return 0;
    if (symbol === undefined) {
      unpricedSymbols.add("UNKNOWN");
      return 0;
    }
    const usd = weiToTokenUSD(symbol, wei, rates);
    if (usd === null) {
      unpricedSymbols.add(symbol);
      return 0;
    }
    return usd;
  };

  for (const instance of instances) {
    upfrontFeesUSD += addPricedWei(
      symbolByCollateralId.get(instance.collateralId),
      BigInt(instance.borrowingFeeCum),
    );
  }

  for (const bracket of brackets) {
    const symbol = symbolByCollateralId.get(bracket.collateralId);
    const totalDebt = BigInt(bracket.totalDebt);
    const sumDebtTimesRateD36 = BigInt(bracket.sumDebtTimesRateD36);
    if (totalDebt > ZERO && sumDebtTimesRateD36 > ZERO) {
      activeInterestBracketCount += 1;
    }
    accruedInterestUSD += addPricedWei(
      symbol,
      accruedInterestWei(bracket, nowSeconds),
    );
    annualizedInterestUSD += addPricedWei(
      symbol,
      annualizedInterestWei(bracket),
    );
  }

  return {
    totalRevenueUSD: upfrontFeesUSD + accruedInterestUSD,
    upfrontFeesUSD,
    accruedInterestUSD,
    annualizedInterestUSD,
    marketCount: collaterals.length,
    activeInterestBracketCount,
    unpricedSymbols: [...unpricedSymbols].sort(),
    bracketsTruncated,
  };
}
