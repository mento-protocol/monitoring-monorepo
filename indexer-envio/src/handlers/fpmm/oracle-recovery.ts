import type { EvmOnEventContext } from "envio";
import { referenceRateFeedIDEffect } from "../../rpc/effects.js";

/** Effect input for `referenceRateFeedIDEffect`; every caller builds it here
 * so preload and processing request an identical key. */
export function referenceRateFeedKey(chainId: number, poolAddress: string) {
  return { chainId, poolAddress };
}

/** Resolve the immutable FPMM feed before an exact block-scoped oracle read.
 * A pool created during a transient RPC failure can have an empty persisted
 * feed even though its contract is fully configured. The cached feed getter
 * repairs that static identity; callers must still use block-scoped effects
 * for mutable expiry/timestamp data. */
export async function resolveReferenceRateFeedForOracleRead(args: {
  chainId: number;
  context: EvmOnEventContext;
  existingFeedId: string;
  poolAddress: string;
}): Promise<string | null> {
  if (args.existingFeedId) return args.existingFeedId;
  return args.context.effect(
    referenceRateFeedIDEffect,
    referenceRateFeedKey(args.chainId, args.poolAddress),
  );
}
