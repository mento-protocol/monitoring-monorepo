// ---------------------------------------------------------------------------
// V2StableToken Transfer handler — mint/burn supply tracking.
//
// Subscribes ERC20 Transfer events with array-OR filter `from=0x0 OR to=0x0`,
// limited to supply-tracked Mento stable addresses listed under
// `V2StableToken` in config.multichain.mainnet.yaml. Each event:
//
//   1. Looks up the running supply entity. First event per token → seeds the
//      baseline from on-chain `totalSupply(block-1)` via the RPC effect. If
//      the effect returns null, skip the write so the next event retries.
//   2. Day-flushes if the event crosses a UTC midnight (writes the previous
//      day's `StableSupplyDailySnapshot` with the accumulated buckets).
//   3. Applies the signed delta (+ for mint, − for burn) to totalSupply and
//      the today-bucket accumulators.
//   4. Writes a `V2StableSupplyChangeEvent` row for the per-tx changes table.
//
// Celo V3 Liquity debt tokens (GBPm/CHFm/JPYm) are excluded from this
// Transfer-zero supply path because their Celo supply is derived from
// LiquityInstance.systemDebt. Their Celo NTT lock/mint manager balances are
// tracked separately in custody.ts. Monad GBPm/CHFm/JPYm are burn/mint NTT
// deployments, so their Monad Transfer-zero events are real chain-local supply
// and are tracked here with source=V3_LIQUITY.
// ---------------------------------------------------------------------------

import type { V2StableSupplyChangeEvent } from "envio";
import { ZERO_ADDRESS } from "../../constants.js";
import { asAddress, eventId } from "../../helpers.js";
import { indexer } from "../../indexer.js";
import { v2StableTotalSupplyEffect } from "../../rpc/effects.js";
import { isSystemAddress } from "../../system-addresses.js";
import {
  getOrCreateV2StableTokenSupply,
  preloadV2StableTokenSupply,
} from "./bootstrap.js";
import { classifyV2StableSupplyChangeKind } from "./classifyKind.js";
import {
  findV2StableByAddress,
  STABLE_TOKEN_CUSTODY_TRANSFER_WHERE_PARAMS,
} from "./config.js";
import { handleStableTokenCustodyTransfer } from "./custody.js";
import { flushV2StableDailySnapshot } from "./dailyFlush.js";

indexer.onEvent(
  {
    contract: "V2StableToken",
    event: "Transfer",
    // Array-OR semantics per envio 3.0.0: deliver Transfer events where
    // EITHER from==0x0 (mint), to==0x0 (burn), from==lock/mint NTT manager, or
    // to==lock/mint NTT manager. Other Transfers are filtered at the HyperSync
    // edge — they never reach the handler.
    // The `0x${string}` casts narrow ZERO_ADDRESS (typed as plain string in
    // constants.ts) to the SingleOrMultiple<`0x${string}`> envio expects.
    // NTT manager proxies are CREATE3-identical on Celo and Monad, so Monad
    // burn/mint manager transfers that match these custody params are also
    // delivered and then dropped by handleStableTokenCustodyTransfer.
    where: () => ({
      params: [
        { from: ZERO_ADDRESS as `0x${string}` },
        { to: ZERO_ADDRESS as `0x${string}` },
        ...STABLE_TOKEN_CUSTODY_TRANSFER_WHERE_PARAMS,
      ],
    }),
  },
  async ({ event, context }) => {
    await handleStableTokenCustodyTransfer({ event, context });

    const { chainId, srcAddress } = event;
    const tokenAddress = asAddress(srcAddress);
    const info = findV2StableByAddress(chainId, tokenAddress);
    // YAML-listed token not in our registry would be a deploy-time bug; bail
    // without writing rather than persist a half-typed row.
    if (!info) return;

    // Normalize via asAddress() for consistency with every other address
    // comparison in the codebase. The zero address is case-invariant
    // (all-zeros looks the same in any checksum scheme), so this happens
    // to work without normalization — but the pattern keeps the
    // comparison safe if the ZERO_ADDRESS constant ever changes shape
    // and lets future copies of this snippet stay correct.
    const isMint = asAddress(event.params.from) === ZERO_ADDRESS;
    const isBurn = asAddress(event.params.to) === ZERO_ADDRESS;
    // `where` filter already enforces (from=0x0 OR to=0x0). A Transfer with
    // both ends zero would be an unsigned-balance reduction of zero — no
    // real ERC20 emits it, but skipping is harmless and keeps the delta
    // sign well-defined downstream.
    if (isMint === isBurn) return;

    const blockNumber = BigInt(event.block.number);
    const blockTimestamp = BigInt(event.block.timestamp);

    if (context.isPreload) {
      await preloadV2StableTokenSupply(
        context,
        chainId,
        tokenAddress,
        blockNumber,
      );
      return;
    }

    let supply = await getOrCreateV2StableTokenSupply(
      context,
      chainId,
      tokenAddress,
      blockNumber,
      blockTimestamp,
    );
    if (!supply) return;

    // First Transfer per token: seed baseline from on-chain
    // totalSupply(block-1). Failure throws → Envio retries the event. We
    // can't silently return null here: that would drop the V2StableSupply-
    // ChangeEvent row + day-bucket contribution for this exact event,
    // while a later event would self-heal `totalSupply` (because the next
    // baseline call would capture this event's delta in its block). The
    // running supply would recover; the event log would not. Throwing
    // forces a clean retry of the original event when RPC recovers.
    if (!supply.supplyBaselineSeeded) {
      const baseline = await context.effect(v2StableTotalSupplyEffect, {
        chainId,
        tokenAddress,
        blockNumber: blockNumber - 1n,
      });
      if (baseline === null) {
        throw new Error(
          `[v2Stables] totalSupply baseline failed for ${tokenAddress} on chain ${chainId} at block ${blockNumber - 1n}. ` +
            `Retrying. Persistent failure halts ingestion until RPC recovers — investigate the chain's RPC endpoint.`,
        );
      }
      supply = {
        ...supply,
        totalSupply: baseline,
        supplyBaselineSeeded: true,
      };
    }

    supply = flushV2StableDailySnapshot(
      context,
      supply,
      blockTimestamp,
      blockNumber,
    );

    const amount = event.params.value;
    const signedDelta = isMint ? amount : -amount;
    supply = {
      ...supply,
      totalSupply: supply.totalSupply + signedDelta,
      mintedTodayBucket: supply.mintedTodayBucket + (isMint ? amount : 0n),
      burnedTodayBucket: supply.burnedTodayBucket + (isBurn ? amount : 0n),
      lastEventBlock: blockNumber,
      lastEventTimestamp: blockTimestamp,
    };
    context.V2StableTokenSupply.set(supply);

    const counterparty = isMint
      ? asAddress(event.params.to)
      : asAddress(event.params.from);
    // `?? ""` mirrors the codebase convention (virtualPool.ts:454,
    // state-sync.ts:507, openLiquidityStrategy.ts:330, nttManager.ts:365).
    // Envio types `transaction.from` as `Address | undefined`; an `as string`
    // cast would crash on an undefined delivery — the empty-string fallback
    // routes such an event through OTHER_* without halting the indexer.
    const caller = asAddress(event.transaction.from ?? "");
    const txTo = event.transaction.to ? asAddress(event.transaction.to) : null;
    const kind = classifyV2StableSupplyChangeKind(chainId, txTo, isMint);

    const changeRow: V2StableSupplyChangeEvent = {
      id: eventId(chainId, event.block.number, event.logIndex),
      chainId,
      tokenAddress,
      tokenSymbol: info.symbol,
      tokenDecimals: info.decimals,
      source: info.source,
      kind,
      counterparty,
      caller,
      txTo: txTo ?? "",
      isSystemCaller: caller !== "" && isSystemAddress(chainId, caller),
      amount: signedDelta,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };
    context.V2StableSupplyChangeEvent.set(changeRow);
  },
);
