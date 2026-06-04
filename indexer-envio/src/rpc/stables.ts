// ---------------------------------------------------------------------------
// Stable supply — Envio effect declarations.
//
// Fetchers live in `stable-fetchers.ts` with no `createEffect` imports so unit
// tests can import pure RPC helpers without registering Envio runtime effects.
// Keeping only declarations here also keeps the handler-facing effect facade
// (`effects.ts`) as the only route into Envio effects.
//
// Used exactly once per (chainId, tokenAddress) by the stable Transfer
// handler to seed the per-token supply baseline on the first observed
// Transfer-with-zero event. Subsequent supply changes are derived from
// Transfer deltas in the handler — this fetcher is the once-per-token entry
// point.
// ---------------------------------------------------------------------------

import { createEffect, S } from "envio";
import {
  fetchStableBalanceOf,
  fetchStableTotalSupply,
} from "./stable-fetchers.js";

// ---------------------------------------------------------------------------
// Effect — block-scoped, address-keyed, `cache: false`.
//
// Group C semantics (see effects.ts:460-465): block-scoped + address-keyed
// effects MUST stay `cache: false` permanently. Celo archive reorgs (rare
// but real) would otherwise replay against persisted cache values — the
// post-reorg block at the same `(chainId, tokenAddress, blockNumber)` key
// can yield a different totalSupply if a mint/burn was rolled back. Fresh
// reads on reindex are the only safe behavior.
//
// On RPC failure or `usedLatestFallback`, the fetcher returns null. The
// handler treats null as "retry" — see src/handlers/stables/transfer.ts.
// (The outer `cache: false` already covers null results too; no
// per-branch `context.cache = false` needed.)
// ---------------------------------------------------------------------------
export const stableTotalSupplyEffect = createEffect(
  {
    name: "stableTotalSupply",
    input: { chainId: S.int32, tokenAddress: S.string, blockNumber: S.bigint },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input, context }) => {
    const result = await fetchStableTotalSupply(
      input.chainId,
      input.tokenAddress,
      input.blockNumber,
      context.log,
    );
    return result;
  },
);

export const stableBalanceOfEffect = createEffect(
  {
    name: "stableBalanceOf",
    input: {
      chainId: S.int32,
      tokenAddress: S.string,
      account: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input, context }) => {
    const result = await fetchStableBalanceOf(
      {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        account: input.account,
        blockNumber: input.blockNumber,
      },
      context.log,
    );
    return result;
  },
);
