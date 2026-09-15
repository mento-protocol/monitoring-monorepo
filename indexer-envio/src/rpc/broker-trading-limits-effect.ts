// Broker trading-limit effect. It lives in its own module (the
// `median-timestamp-effect.ts` precedent) because `effects.ts` is already near
// its line budget; `effects.ts` re-exports it so every effect stays reachable
// from one import site.

import { S } from "envio";
import { fetchBrokerTradingLimit } from "./broker-trading-limits.js";
import { createEffect } from "./tracked-effect.js";

const brokerLimitConfigShape = S.schema({
  timestep0: S.bigint,
  timestep1: S.bigint,
  limit0: S.bigint,
  limit1: S.bigint,
  limitGlobal: S.bigint,
  flags: S.int32,
});

const brokerLimitStateShape = S.schema({
  lastUpdated0: S.bigint,
  lastUpdated1: S.bigint,
  netflow0: S.bigint,
  netflow1: S.bigint,
  netflowGlobal: S.bigint,
});

/** One dispatch reads state, and on a config bootstrap one more. Celo's
 * primary RPC serves 200 eth_call/s; 50 leaves headroom for the oracle and
 * FPMM effects that share it during replay. */
const BROKER_TRADING_LIMIT_CALLS_PER_SECOND = 50;

/** MUST stay `cache: false` permanently — netflow is block-scoped state. */
export const brokerTradingLimitEffect = createEffect(
  {
    name: "brokerTradingLimit",
    input: {
      chainId: S.int32,
      brokerAddress: S.string,
      limitId: S.string,
      blockNumber: S.bigint,
      readConfig: S.boolean,
    },
    output: S.nullable(
      S.schema({
        config: S.nullable(brokerLimitConfigShape),
        state: brokerLimitStateShape,
      }),
    ),
    rateLimit: { calls: BROKER_TRADING_LIMIT_CALLS_PER_SECOND, per: "second" },
    cache: false,
  },
  async ({ input, context }) =>
    (await fetchBrokerTradingLimit({
      chainId: input.chainId,
      brokerAddress: input.brokerAddress,
      limitId: input.limitId,
      blockNumber: input.blockNumber,
      readConfig: input.readConfig,
      log: context.log,
    })) ?? null,
);
