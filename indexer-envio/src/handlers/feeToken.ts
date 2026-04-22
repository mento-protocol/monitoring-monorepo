// ---------------------------------------------------------------------------
// ERC20FeeToken Transfer handler — protocol fee tracking
// ---------------------------------------------------------------------------

import { ERC20FeeToken, type ProtocolFeeTransfer } from "generated";
import { eventId, asAddress, makePoolId } from "../helpers";
import {
  YIELD_SPLIT_ADDRESS,
  resolveFeeTokenMeta,
  selectStaleTransfers,
  backfilledTokens,
} from "../feeToken";

ERC20FeeToken.Transfer.handler(
  async ({ event, context }) => {
    // Sender provenance check: only persist transfers originating from known
    // FPMM pools. This prevents arbitrary third-party transfers to the yield
    // split address from inflating the protocol fee KPIs.
    const sender = asAddress(event.params.from);
    const pool = await context.Pool.get(makePoolId(event.chainId, sender));
    if (!pool || !pool.source.includes("fpmm")) {
      return; // Not from a known FPMM pool — skip
    }

    const { chainId } = event;
    const tokenAddress = event.srcAddress;
    const { symbol, decimals } = await resolveFeeTokenMeta(
      chainId,
      tokenAddress,
    );

    const id = eventId(chainId, event.block.number, event.logIndex);
    const normalizedToken = asAddress(tokenAddress);

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

    // Backfill: if RPC succeeded and we now know the real symbol, fix any
    // previously stored UNKNOWN records for this token.
    const backfillKey = `${chainId}:${normalizedToken}`;
    if (symbol !== "UNKNOWN" && !backfilledTokens.has(backfillKey)) {
      try {
        const unknownRecords =
          await context.ProtocolFeeTransfer.getWhere.token.eq(normalizedToken);
        for (const stale of selectStaleTransfers(unknownRecords, chainId)) {
          context.ProtocolFeeTransfer.set({
            ...stale,
            tokenSymbol: symbol,
            tokenDecimals: decimals,
          });
        }
        backfilledTokens.add(backfillKey);
      } catch (err) {
        console.warn(
          `[ERC20FeeToken] Backfill scan failed for ${normalizedToken} on chain ${chainId}. ` +
            `Will retry on next transfer.`,
          err,
        );
      }
    }
  },
  {
    // Topic-level filter: Envio only delivers Transfer events where `to`
    // matches the yield split address.
    eventFilters: { to: YIELD_SPLIT_ADDRESS },
  },
);
