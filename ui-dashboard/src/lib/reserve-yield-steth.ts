import { fetchJson, isRecord, numericField } from "@/lib/reserve-yield-shared";
import type { FetchImpl } from "@/lib/reserve-yield-types";

const LIDO_STETH_APR_URL = "https://eth-api.lido.fi/v1/protocol/steth/apr/last";

const STETH_CHAIN_ID = 1;
const STETH_SYMBOL = "STETH";
const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";

function validateStethMeta(meta: unknown): void {
  if (!isRecord(meta)) {
    throw new Error("Lido stETH APR response did not contain metadata");
  }
  const symbol =
    typeof meta.symbol === "string" ? meta.symbol.trim().toUpperCase() : "";
  const address =
    typeof meta.address === "string" ? meta.address.trim().toLowerCase() : "";
  const chainId = numericField(meta.chainId);
  if (symbol !== STETH_SYMBOL) {
    throw new Error("Lido stETH APR metadata symbol did not match stETH");
  }
  if (address !== STETH_ADDRESS) {
    throw new Error("Lido stETH APR metadata address did not match stETH");
  }
  if (chainId !== STETH_CHAIN_ID) {
    throw new Error("Lido stETH APR metadata chainId did not match Ethereum");
  }
}

export function parseLidoStethApyPercent(payload: unknown): number {
  if (!isRecord(payload)) {
    throw new Error("Lido stETH APR response was not an object");
  }
  validateStethMeta(payload.meta);

  const data = isRecord(payload.data) ? payload.data : null;
  const apr = data === null ? null : numericField(data.apr);
  if (apr === null || apr < 0) {
    throw new Error("Lido stETH APR response did not contain a valid APR");
  }
  return apr;
}

export async function fetchLidoStethApy(fetchImpl: FetchImpl): Promise<number> {
  return fetchJson(fetchImpl, LIDO_STETH_APR_URL).then(
    parseLidoStethApyPercent,
  );
}
