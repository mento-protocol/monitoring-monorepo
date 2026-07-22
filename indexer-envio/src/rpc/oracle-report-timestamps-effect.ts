import { S } from "envio";
import { fetchOracleReportTimestamps } from "./oracle-state.js";
import {
  MEDIAN_TIMESTAMP_RATE_LIMITS,
  oracleRpcProviderFamily,
  type OracleRpcProviderFamily,
} from "./median-timestamp-effect.js";
import { createEffect } from "./tracked-effect.js";

const oracleReportTimestampsShape = S.schema({
  reporters: S.array(S.string),
  timestamps: S.array(S.bigint),
});

function createOracleReportTimestampsEffect(
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
      output: S.nullable(oracleReportTimestampsShape),
      // Even though this effect executes only once per tracked feed, keep
      // provider-family limiter state isolated like every other oracle RPC.
      rateLimit: MEDIAN_TIMESTAMP_RATE_LIMITS[family],
      cache: false,
    },
    async ({ input, context }) =>
      (await fetchOracleReportTimestamps(
        input.chainId,
        input.rateFeedID,
        input.blockNumber,
        context.log,
      )) ?? null,
  );
}

const polygonOracleReportTimestampsEffect = createOracleReportTimestampsEffect(
  "oracleReportTimestampsPolygon",
  "polygon",
);
const celoOracleReportTimestampsEffect = createOracleReportTimestampsEffect(
  "oracleReportTimestampsCelo",
  "celo",
);
const monadOracleReportTimestampsEffect = createOracleReportTimestampsEffect(
  "oracleReportTimestampsMonad",
  "monad",
);
const defaultOracleReportTimestampsEffect = createOracleReportTimestampsEffect(
  "oracleReportTimestampsDefault",
  "default",
);

/** Select a stable provider-scoped object so bounded bootstraps on one chain
 * cannot throttle another chain in the shared multichain process. */
export function oracleReportTimestampsEffectForChain(chainId: number) {
  switch (oracleRpcProviderFamily(chainId)) {
    case "polygon":
      return polygonOracleReportTimestampsEffect;
    case "celo":
      return celoOracleReportTimestampsEffect;
    case "monad":
      return monadOracleReportTimestampsEffect;
    case "default":
      return defaultOracleReportTimestampsEffect;
  }
}
