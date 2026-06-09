// ---------------------------------------------------------------------------
// ERC20FeeToken Transfer handler — protocol fee tracking
// ---------------------------------------------------------------------------

import type { ProtocolFeeTransfer } from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, isVirtualPool, makePoolId } from "../helpers.js";
import {
  YIELD_SPLIT_ADDRESS,
  UNKNOWN_FEE_TOKEN_META,
  selectStaleTransfers,
  backfilledTokens,
} from "../feeToken.js";
import {
  preloadPoolDailyFeeSnapshot,
  upsertPoolDailyFeeSnapshot,
} from "../protocolFeeSnapshot.js";
import { feeTokenMetaEffect } from "../rpc/effects.js";

indexer.onEvent(
  {
    contract: "ERC20FeeToken",
    event: "Transfer",
    // Topic-level filter: Envio only delivers Transfer events where `to`
    // matches the yield split address.
    where: () => ({ params: { to: YIELD_SPLIT_ADDRESS } }),
  },
  async ({ event, context }) => {
    // Sender provenance check: only persist transfers originating from indexed
    // FPMM/VirtualPool rows. This prevents arbitrary third-party transfers to
    // the yield split address from inflating the protocol fee KPIs while still
    // counting every pool type the revenue page lists.
    const sender = asAddress(event.params.from);
    const poolId = makePoolId(event.chainId, sender);
    const pool = await context.Pool.get(poolId);
    if (!pool || (!pool.source.includes("fpmm") && !isVirtualPool(pool))) {
      return; // Not from a known revenue-tracked pool — skip
    }

    const { chainId } = event;
    const tokenAddress = event.srcAddress;
    const { symbol, decimals } =
      (await context.effect(feeTokenMetaEffect, {
        chainId,
        tokenAddress,
      })) ?? UNKNOWN_FEE_TOKEN_META;

    const id = eventId(chainId, event.block.number, event.logIndex);
    const normalizedToken = asAddress(tokenAddress);

    // Replay/reorg dedup: ProtocolFeeTransfer is event-id-keyed (same id =
    // overwrite, idempotent), but the snapshot rollup is additive. If we've
    // already indexed this event, branch:
    //   - prior was UNKNOWN, symbol now resolved → snapshot heal-only path
    //     (repair metadata + reprice the prior amount; don't double-count it)
    //   - otherwise → replay no-op for the snapshot; the raw transfer row
    //     still gets `set` below so the self-heal backfill still propagates.
    const existingTransfer = await context.ProtocolFeeTransfer.get(id);
    if (context.isPreload) {
      await preloadPoolDailyFeeSnapshot({
        context,
        pool,
        blockTimestamp: BigInt(event.block.timestamp),
      });
      const backfillKey = `${chainId}:${normalizedToken}`;
      if (symbol !== "UNKNOWN" && !backfilledTokens.has(backfillKey)) {
        const unknownRecords = await context.ProtocolFeeTransfer.getWhere({
          token: { _eq: normalizedToken },
        });
        const stale = selectStaleTransfers(unknownRecords, chainId);
        await Promise.all(
          stale.map(async (s) => {
            const stalePool = await context.Pool.get(
              makePoolId(chainId, s.from),
            );
            if (stalePool) {
              await preloadPoolDailyFeeSnapshot({
                context,
                pool: stalePool,
                blockTimestamp: BigInt(s.blockTimestamp),
              });
            }
          }),
        );
      }
      return;
    }

    const transfer: ProtocolFeeTransfer = {
      id,
      chainId,
      token: normalizedToken,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      amount: event.params.value,
      from: sender,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
    };

    context.ProtocolFeeTransfer.set(transfer);

    // Upsert the per-pool daily fee snapshot in the right mode.
    if (!existingTransfer) {
      await upsertPoolDailyFeeSnapshot({
        context,
        chainId,
        pool,
        blockTimestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        token: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        amount: event.params.value,
        mode: "add",
      });
    } else if (
      existingTransfer.tokenSymbol === "UNKNOWN" &&
      symbol !== "UNKNOWN"
    ) {
      await upsertPoolDailyFeeSnapshot({
        context,
        chainId,
        pool,
        blockTimestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        token: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        amount: event.params.value,
        mode: "heal",
      });
    }
    // else: identical replay — snapshot already counted this event; no-op.

    // Backfill: if RPC succeeded and we now know the real symbol, fix any
    // previously stored UNKNOWN records for this token AND heal the
    // corresponding `PoolDailyFeeSnapshot` rows for those past days. The
    // raw-row backfill alone leaves the daily rollup permanently understated
    // when an UNKNOWN token resolves on a later day, which would make the
    // dashboard's volume wrong once it switches off the raw-transfer
    // path. `mergeFeeSnapshot` heal-mode is idempotent on a slot-by-slot
    // basis, so iterating per stale transfer is safe — repeated heals for
    // the same (pool, day, token) tuple are no-ops after the first.
    const backfillKey = `${chainId}:${normalizedToken}`;
    if (symbol !== "UNKNOWN" && !backfilledTokens.has(backfillKey)) {
      try {
        const unknownRecords = await context.ProtocolFeeTransfer.getWhere({
          token: { _eq: normalizedToken },
        });
        const stale = selectStaleTransfers(unknownRecords, chainId);
        // Cache pool fetches across the loop — many stale transfers share a
        // pool, especially on busy chains.
        const poolCache = new Map<
          string,
          Awaited<ReturnType<typeof context.Pool.get>>
        >();
        for (const s of stale) {
          context.ProtocolFeeTransfer.set({
            ...s,
            tokenSymbol: symbol,
            tokenDecimals: decimals,
          });

          // Heal the original day's snapshot.
          const stalePoolId = makePoolId(chainId, s.from);
          // `.has()` (not `.get() === undefined`) so a cached negative
          // lookup (`undefined` value) doesn't re-query on every iteration.
          let stalePool: Awaited<ReturnType<typeof context.Pool.get>>;
          if (poolCache.has(stalePoolId)) {
            stalePool = poolCache.get(stalePoolId);
          } else {
            stalePool = await context.Pool.get(stalePoolId);
            poolCache.set(stalePoolId, stalePool);
          }
          if (stalePool) {
            const sBlockTs = BigInt(s.blockTimestamp);
            const sBlockNum = BigInt(s.blockNumber);
            await upsertPoolDailyFeeSnapshot({
              context,
              chainId,
              pool: stalePool,
              blockTimestamp: sBlockTs,
              blockNumber: sBlockNum,
              token: s.token,
              tokenSymbol: symbol,
              tokenDecimals: decimals,
              amount: s.amount,
              mode: "heal",
            });
          }
        }
        backfilledTokens.add(backfillKey);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        context.log.warn(
          `[ERC20FeeToken] Backfill scan failed for ${normalizedToken} on chain ${chainId}: ${reason}. ` +
            `Will retry on next transfer.`,
        );
      }
    }
  },
);
