import { S } from "envio";
import { fetchMedianTimestamp } from "./oracle-state.js";
import { createEffect } from "./tracked-effect.js";

export type OracleRpcProviderFamily = "polygon" | "celo" | "monad" | "default";

export const MEDIAN_TIMESTAMP_RATE_LIMITS = {
  // dRPC's stressed public-tier floor is 40 eth_call/s.
  polygon: { calls: 40, per: "second" },
  // Restore the rate that Celo replays used successfully before Polygon's
  // public-tier floor was added to the formerly shared effect.
  celo: { calls: 200, per: "second" },
  // Monad capacity has not been measured independently yet.
  monad: { calls: 40, per: "second" },
  // New chains stay isolated until their provider capacity is measured and
  // they are assigned an explicit family above.
  default: { calls: 40, per: "second" },
} as const;

export function oracleRpcProviderFamily(
  chainId: number,
): OracleRpcProviderFamily {
  if (chainId === 137 || chainId === 80002) return "polygon";
  if (chainId === 42220 || chainId === 11142220) return "celo";
  if (chainId === 143 || chainId === 10143) return "monad";
  return "default";
}

function createMedianTimestampEffect(
  name: string,
  family: OracleRpcProviderFamily,
) {
  return createEffect(
    {
      name,
      input: {
        chainId: S.int32,
        rateFeedID: S.string,
        blockNumber: S.bigint,
      },
      output: S.nullable(S.bigint),
      // Rate-limit state lives on the effect object in Envio. Keep provider
      // families on distinct objects so Polygon's public-tier floor cannot
      // throttle Celo or Monad in the multichain replay.
      rateLimit: MEDIAN_TIMESTAMP_RATE_LIMITS[family],
      cache: false,
    },
    async ({ input, context }) =>
      (await fetchMedianTimestamp(
        input.chainId,
        input.rateFeedID,
        input.blockNumber,
        context.log,
      )) ?? null,
  );
}

const polygonMedianTimestampEffect = createMedianTimestampEffect(
  "medianTimestampPolygon",
  "polygon",
);
const celoMedianTimestampEffect = createMedianTimestampEffect(
  "medianTimestampCelo",
  "celo",
);
const monadMedianTimestampEffect = createMedianTimestampEffect(
  "medianTimestampMonad",
  "monad",
);
const defaultMedianTimestampEffect = createMedianTimestampEffect(
  "medianTimestampDefault",
  "default",
);

/** Select one stable effect object per provider family. Using the same object
 * in preload and processing preserves Envio's identical-input deduplication. */
export function medianTimestampEffectForChain(chainId: number) {
  switch (oracleRpcProviderFamily(chainId)) {
    case "polygon":
      return polygonMedianTimestampEffect;
    case "celo":
      return celoMedianTimestampEffect;
    case "monad":
      return monadMedianTimestampEffect;
    case "default":
      return defaultMedianTimestampEffect;
  }
}
