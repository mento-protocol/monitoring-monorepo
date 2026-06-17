import { ZERO_ADDRESS } from "../../constants.js";
import { eventId } from "../../helpers.js";
import {
  consumeLots,
  createLot,
  getPosition,
  setPosition,
} from "./positions.js";
import {
  ZERO,
  isTrackedWallet,
  positiveDelta,
  valueForShares,
  type EventMeta,
  type SusdsContext,
} from "./shared.js";

export async function shouldProcess(
  context: SusdsContext,
  movementId: string,
): Promise<boolean> {
  return (await context.SusdsYieldMovement.get(movementId)) === undefined;
}

export async function recordDeposit(
  context: SusdsContext,
  meta: EventMeta,
  owner: string,
  assets: bigint,
  shares: bigint,
  sharePriceUsdWei: bigint,
): Promise<void> {
  const position = await getPosition(context, meta.chainId, owner, meta);
  createLot(context, {
    wallet: owner,
    shares,
    costBasisUsdWei: assets,
    meta,
    suffix: "deposit",
  });
  setPosition(
    context,
    {
      ...position,
      shares: position.shares + shares,
      costBasisUsdWei: position.costBasisUsdWei + assets,
    },
    meta,
  );
  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind: "deposit",
    from: ZERO_ADDRESS,
    to: owner,
    shares,
    assetsUsdWei: assets,
    costBasisUsdWei: assets,
    yieldUsdWei: ZERO,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}

export async function recordWithdraw(
  context: SusdsContext,
  meta: EventMeta,
  {
    owner,
    receiver,
    assets,
    shares,
    sharePriceUsdWei,
  }: {
    owner: string;
    receiver: string;
    assets: bigint;
    shares: bigint;
    sharePriceUsdWei: bigint;
  },
): Promise<void> {
  const costBasisUsdWei = await consumeLots(context, owner, shares, meta);
  const yieldUsdWei = positiveDelta(assets, costBasisUsdWei);
  const position = await getPosition(context, meta.chainId, owner, meta);
  if (position.shares < shares || position.costBasisUsdWei < costBasisUsdWei) {
    throw new Error(`[sUSDS] withdrawal exceeds tracked position for ${owner}`);
  }
  setPosition(
    context,
    {
      ...position,
      shares: position.shares - shares,
      costBasisUsdWei: position.costBasisUsdWei - costBasisUsdWei,
      realizedYieldUsdWei: position.realizedYieldUsdWei + yieldUsdWei,
      redeemedYieldUsdWei: position.redeemedYieldUsdWei + yieldUsdWei,
    },
    meta,
  );
  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind: "withdraw",
    from: owner,
    to: receiver,
    shares,
    assetsUsdWei: assets,
    costBasisUsdWei,
    yieldUsdWei,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}

export async function recordTransfer(
  context: SusdsContext,
  meta: EventMeta,
  from: string,
  to: string,
  shares: bigint,
  sharePriceUsdWei: bigint,
): Promise<void> {
  const fromTracked = isTrackedWallet(from);
  const toTracked = isTrackedWallet(to);
  const assetsUsdWei = valueForShares(shares, sharePriceUsdWei);
  let kind = "transfer_in";
  let costBasisUsdWei = assetsUsdWei;
  let yieldUsdWei = ZERO;

  if (fromTracked && toTracked) {
    kind = "internal_transfer";
    costBasisUsdWei = await consumeLots(context, from, shares, meta);
    const fromPosition = await getPosition(context, meta.chainId, from, meta);
    const toPosition = await getPosition(context, meta.chainId, to, meta);
    if (
      fromPosition.shares < shares ||
      fromPosition.costBasisUsdWei < costBasisUsdWei
    ) {
      throw new Error(`[sUSDS] internal transfer exceeds position for ${from}`);
    }
    setPosition(
      context,
      {
        ...fromPosition,
        shares: fromPosition.shares - shares,
        costBasisUsdWei: fromPosition.costBasisUsdWei - costBasisUsdWei,
      },
      meta,
    );
    createLot(context, {
      wallet: to,
      shares,
      costBasisUsdWei,
      meta,
      suffix: "internal",
    });
    setPosition(
      context,
      {
        ...toPosition,
        shares: toPosition.shares + shares,
        costBasisUsdWei: toPosition.costBasisUsdWei + costBasisUsdWei,
      },
      meta,
    );
  } else if (fromTracked) {
    kind = "transfer_out";
    costBasisUsdWei = await consumeLots(context, from, shares, meta);
    yieldUsdWei = positiveDelta(assetsUsdWei, costBasisUsdWei);
    const position = await getPosition(context, meta.chainId, from, meta);
    if (
      position.shares < shares ||
      position.costBasisUsdWei < costBasisUsdWei
    ) {
      throw new Error(`[sUSDS] transfer out exceeds position for ${from}`);
    }
    setPosition(
      context,
      {
        ...position,
        shares: position.shares - shares,
        costBasisUsdWei: position.costBasisUsdWei - costBasisUsdWei,
        realizedYieldUsdWei: position.realizedYieldUsdWei + yieldUsdWei,
        transferredOutYieldUsdWei:
          position.transferredOutYieldUsdWei + yieldUsdWei,
      },
      meta,
    );
  } else if (toTracked) {
    createLot(context, {
      wallet: to,
      shares,
      costBasisUsdWei,
      meta,
      suffix: "transfer-in",
    });
    const position = await getPosition(context, meta.chainId, to, meta);
    setPosition(
      context,
      {
        ...position,
        shares: position.shares + shares,
        costBasisUsdWei: position.costBasisUsdWei + costBasisUsdWei,
      },
      meta,
    );
  } else {
    return;
  }

  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind,
    from,
    to,
    shares,
    assetsUsdWei,
    costBasisUsdWei,
    yieldUsdWei,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}
