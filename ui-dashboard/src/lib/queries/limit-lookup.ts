// Resolver query for `/limit/[limitId]`. A Broker trading-limit alert carries
// only the bytes32 mapping key, so the route trades it for the wrapping
// VirtualPool and redirects to that pool page's Limits tab.
//
// The operation name deliberately avoids the substring "TradingLimits": the
// pool-page query tests route and count the FPMM query on that substring.
//
// One Hasura endpoint serves several chains, so the lookup is scoped by
// `chainId`: without it the same limit id on a second chain could answer for
// the one that fired. `limitId` is unique per exchange leg within a chain, so
// `limit: 1` is a safety cap.

import { z } from "zod/mini";

// `poolId` is chain-namespaced (`<chainId>-<address>`), so the redirect target
// needs no separate chain field.
export const BROKER_LIMIT_POOL = `
  query BrokerLimitPool($limitId: String!, $chainId: Int!) {
    BrokerTradingLimit(
      where: { limitId: { _eq: $limitId }, chainId: { _eq: $chainId } }
      limit: 1
    ) {
      poolId
    }
  }
`;

export const BrokerLimitPoolSchema = z.object({
  BrokerTradingLimit: z.array(z.object({ poolId: z.string() })),
});
