import {
  errorMessage,
  fetchJson,
  fetchJsonRpcEthCall,
  isRecord,
  joinErrors,
  numericField,
} from "@/lib/reserve-yield-shared";
import type {
  FetchImpl,
  SkySavingsRateObservation,
} from "@/lib/reserve-yield-types";

const SKY_SUSDS_RPC_URL = "https://ethereum.publicnode.com";
const SKY_SUSDS_CONTRACT_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
const SKY_SUSDS_SSR_CALL_DATA = "0x03607ceb";
const SKY_OVERALL_URL = "https://info-sky.blockanalitica.com/api/v1/overall/";
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export function parseSkySavingsRateApyPercent(payload: unknown): number {
  const records = Array.isArray(payload) ? payload : [payload];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const rate = numericField(record.sky_savings_rate_apy);
    if (rate === null) continue;
    if (rate > 1) {
      throw new Error(
        `sky_savings_rate_apy looks like a percent (${rate}), expected a decimal fraction`,
      );
    }
    return rate * 100;
  }

  throw new Error("Sky overall response did not contain sky_savings_rate_apy");
}

export function computeSkySavingsRateApyPercentFromSsr(ssrRay: bigint): number {
  const perSecondRate = Number(ssrRay) / 1e27;
  if (!Number.isFinite(perSecondRate) || perSecondRate < 1) {
    throw new Error(`sUSDS ssr() returned invalid ray value ${ssrRay}`);
  }
  return (Math.pow(perSecondRate, SECONDS_PER_YEAR) - 1) * 100;
}

export function parseSkySavingsRateSsrApyPercent(payload: unknown): number {
  if (!isRecord(payload)) {
    throw new Error("sUSDS ssr() RPC response was not an object");
  }

  if (isRecord(payload.error)) {
    const code = numericField(payload.error.code);
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "unknown RPC error";
    throw new Error(code === null ? message : `RPC ${code}: ${message}`);
  }

  const result = payload.result;
  if (
    typeof result !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(result) ||
    result === "0x"
  ) {
    throw new Error(
      "sUSDS ssr() RPC response did not contain a uint256 result",
    );
  }

  return computeSkySavingsRateApyPercentFromSsr(BigInt(result));
}

async function fetchOnchainSkySavingsRate(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  const apyPercent = await fetchJsonRpcEthCall(fetchImpl, {
    rpcUrl: SKY_SUSDS_RPC_URL,
    to: SKY_SUSDS_CONTRACT_ADDRESS,
    data: SKY_SUSDS_SSR_CALL_DATA,
  }).then(parseSkySavingsRateSsrApyPercent);
  return { apyPercent, source: "onchain-susds-ssr" };
}

async function fetchBlockAnaliticaSkySavingsRateFallback(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  const apyPercent = await fetchJson(fetchImpl, SKY_OVERALL_URL).then(
    parseSkySavingsRateApyPercent,
  );
  return { apyPercent, source: "blockanalitica-overall" };
}

export async function fetchSkySavingsRate(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  try {
    return await fetchOnchainSkySavingsRate(fetchImpl);
  } catch (primaryErr) {
    try {
      return await fetchBlockAnaliticaSkySavingsRateFallback(fetchImpl);
    } catch (fallbackErr) {
      throw new Error(
        joinErrors(
          errorMessage("on-chain sUSDS.ssr()", primaryErr),
          errorMessage("Block Analitica fallback", fallbackErr),
        ) ?? "Sky Savings Rate unavailable",
        { cause: fallbackErr },
      );
    }
  }
}
