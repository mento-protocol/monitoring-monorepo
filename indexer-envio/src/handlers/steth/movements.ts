import { ZERO_ADDRESS } from "../../constants.js";
import { eventId } from "../../helpers.js";
import {
  consumePrincipalLots,
  createLot,
  getPosition,
  setPosition,
} from "./positions.js";
import {
  ZERO,
  isTrackedWallet,
  type EventMeta,
  type StethContext,
} from "./shared.js";

export async function shouldProcess(
  context: StethContext,
  movementId: string,
): Promise<boolean> {
  return (await context.StethYieldMovement.get(movementId)) === undefined;
}

function subtractFloor(value: bigint, amount: bigint): bigint {
  return value > amount ? value - amount : ZERO;
}

function principalRequiredForOutflow(
  position: { principalAmount: bigint },
  amount: bigint,
): bigint {
  return position.principalAmount < amount ? position.principalAmount : amount;
}

export async function recordTransfer(
  context: StethContext,
  meta: EventMeta,
  from: string,
  to: string,
  amount: bigint,
): Promise<boolean> {
  const fromTracked = isTrackedWallet(from);
  const toTracked = isTrackedWallet(to);
  let kind = "transfer_in";
  let principalAmount = amount;
  let yieldAmount = ZERO;

  if (fromTracked && toTracked) {
    kind = "internal_transfer";
    const fromPosition = await getPosition(context, meta.chainId, from, meta);
    const consumedPrincipal = await consumePrincipalLots(
      context,
      from,
      amount,
      meta,
      principalRequiredForOutflow(fromPosition, amount),
    );
    principalAmount = consumedPrincipal;
    const toPosition = await getPosition(context, meta.chainId, to, meta);
    setPosition(
      context,
      {
        ...fromPosition,
        balance: subtractFloor(fromPosition.balance, amount),
        principalAmount: subtractFloor(
          fromPosition.principalAmount,
          principalAmount,
        ),
      },
      meta,
    );
    createLot(context, {
      wallet: to,
      amount: principalAmount,
      meta,
      suffix: "internal",
    });
    setPosition(
      context,
      {
        ...toPosition,
        balance: toPosition.balance + amount,
        principalAmount: toPosition.principalAmount + principalAmount,
      },
      meta,
    );
  } else if (fromTracked) {
    kind = "transfer_out";
    const position = await getPosition(context, meta.chainId, from, meta);
    const consumedPrincipal = await consumePrincipalLots(
      context,
      from,
      amount,
      meta,
      principalRequiredForOutflow(position, amount),
    );
    principalAmount = consumedPrincipal;
    yieldAmount = amount - principalAmount;
    setPosition(
      context,
      {
        ...position,
        balance: subtractFloor(position.balance, amount),
        principalAmount: subtractFloor(
          position.principalAmount,
          principalAmount,
        ),
        realizedYieldAmount: position.realizedYieldAmount + yieldAmount,
        transferredOutYieldAmount:
          position.transferredOutYieldAmount + yieldAmount,
      },
      meta,
    );
  } else if (toTracked) {
    const position = await getPosition(context, meta.chainId, to, meta);
    createLot(context, {
      wallet: to,
      amount,
      meta,
      suffix: from === ZERO_ADDRESS ? "mint" : "transfer-in",
    });
    setPosition(
      context,
      {
        ...position,
        balance: position.balance + amount,
        principalAmount: position.principalAmount + amount,
      },
      meta,
    );
  } else {
    return false;
  }

  context.StethYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind,
    from,
    to,
    amount,
    principalAmount,
    yieldAmount,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
  return true;
}
