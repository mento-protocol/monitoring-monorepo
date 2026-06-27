import type {
  PendingStabilityPoolConsumption,
  StabilityPoolDepositor,
  StabilityPoolLossAccumulator,
  StabilityPoolLossScale,
} from "envio";

const P_PRECISION = 10n ** 36n;
const SCALE_FACTOR = 10n ** 9n;
const MAX_SCALE_FACTOR_EXPONENT = 8n;

export type StabilityPoolLossSource = "rebalance" | "liquidation";

export type StabilityPoolSourceLoss = {
  rebalance: bigint;
  liquidation: bigint;
};

type LossAccumulatorEntity = {
  get: (id: string) => Promise<StabilityPoolLossAccumulator | undefined>;
  set: (entity: StabilityPoolLossAccumulator) => void;
};

type LossScaleEntity = {
  get: (id: string) => Promise<StabilityPoolLossScale | undefined>;
  set: (entity: StabilityPoolLossScale) => void;
};

type PendingConsumptionEntity = {
  get: (id: string) => Promise<PendingStabilityPoolConsumption | undefined>;
  set: (entity: PendingStabilityPoolConsumption) => void;
  deleteUnsafe: (id: string) => void;
};

export type StabilityPoolLossContext = {
  StabilityPoolLossAccumulator: LossAccumulatorEntity;
  StabilityPoolLossScale: LossScaleEntity;
  PendingStabilityPoolConsumption: PendingConsumptionEntity;
};

const consumptionId = (
  chainId: number,
  txHash: string,
  collateralId: string,
): string => `${chainId}-${txHash}-${collateralId}`;

const scaleId = (collateralId: string, scale: bigint): string =>
  `${collateralId}-${scale}`;

const makeAccumulator = (
  chainId: number,
  collateralId: string,
): StabilityPoolLossAccumulator => ({
  id: collateralId,
  chainId,
  collateralId,
  currentP: P_PRECISION,
  currentScale: 0n,
  totalBoldDeposits: 0n,
});

const makeScale = (
  chainId: number,
  collateralId: string,
  scale: bigint,
): StabilityPoolLossScale => ({
  id: scaleId(collateralId, scale),
  chainId,
  collateralId,
  scale,
  rebalanceLossSum: 0n,
  liquidationLossSum: 0n,
});

export async function loadStabilityPoolLossScale(
  context: Pick<StabilityPoolLossContext, "StabilityPoolLossScale">,
  chainId: number,
  collateralId: string,
  scale: bigint,
): Promise<StabilityPoolLossScale> {
  return (
    (await context.StabilityPoolLossScale.get(scaleId(collateralId, scale))) ??
    makeScale(chainId, collateralId, scale)
  );
}

export async function loadStabilityPoolLossAccumulator(
  context: StabilityPoolLossContext,
  chainId: number,
  collateralId: string,
): Promise<StabilityPoolLossAccumulator> {
  return (
    (await context.StabilityPoolLossAccumulator.get(collateralId)) ??
    makeAccumulator(chainId, collateralId)
  );
}

export async function loadPendingStabilityPoolConsumption(
  context: StabilityPoolLossContext,
  chainId: number,
  txHash: string,
  collateralId: string,
): Promise<PendingStabilityPoolConsumption | undefined> {
  return context.PendingStabilityPoolConsumption.get(
    consumptionId(chainId, txHash, collateralId),
  );
}

export async function beginStabilityPoolConsumption(
  context: StabilityPoolLossContext,
  {
    chainId,
    collateralId,
    txHash,
    blockNumber,
    blockTimestamp,
  }: {
    chainId: number;
    collateralId: string;
    txHash: string;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<void> {
  const accumulator = await loadStabilityPoolLossAccumulator(
    context,
    chainId,
    collateralId,
  );
  context.StabilityPoolLossAccumulator.set(accumulator);
  context.PendingStabilityPoolConsumption.set({
    id: consumptionId(chainId, txHash, collateralId),
    chainId,
    collateralId,
    txHash,
    pBefore: accumulator.currentP,
    pAfter: accumulator.currentP,
    scaleBefore: accumulator.currentScale,
    scaleAfter: accumulator.currentScale,
    totalBefore: accumulator.totalBoldDeposits,
    totalAfter: accumulator.totalBoldDeposits,
    stableOut: 0n,
    timestamp: blockTimestamp,
    blockNumber,
  });
}

export async function recordStabilityPoolScaleUpdate(
  context: StabilityPoolLossContext,
  {
    chainId,
    collateralId,
    txHash,
    currentScale,
  }: {
    chainId: number;
    collateralId: string;
    txHash: string;
    currentScale: bigint;
  },
): Promise<void> {
  const [accumulator, pending] = await Promise.all([
    loadStabilityPoolLossAccumulator(context, chainId, collateralId),
    loadPendingStabilityPoolConsumption(context, chainId, txHash, collateralId),
  ]);
  context.StabilityPoolLossAccumulator.set({
    ...accumulator,
    currentScale,
  });
  if (pending !== undefined) {
    context.PendingStabilityPoolConsumption.set({
      ...pending,
      scaleAfter: currentScale,
    });
  }
}

export async function recordStabilityPoolPUpdate(
  context: StabilityPoolLossContext,
  {
    chainId,
    collateralId,
    txHash,
    currentP,
  }: {
    chainId: number;
    collateralId: string;
    txHash: string;
    currentP: bigint;
  },
): Promise<void> {
  const [accumulator, pending] = await Promise.all([
    loadStabilityPoolLossAccumulator(context, chainId, collateralId),
    loadPendingStabilityPoolConsumption(context, chainId, txHash, collateralId),
  ]);
  const nextAccumulator = {
    ...accumulator,
    currentP,
  };
  context.StabilityPoolLossAccumulator.set(nextAccumulator);
  if (pending !== undefined) {
    context.PendingStabilityPoolConsumption.set({
      ...pending,
      pAfter: currentP,
      scaleAfter: nextAccumulator.currentScale,
    });
  }
}

export async function recordStabilityPoolTotalDepositUpdate(
  context: StabilityPoolLossContext,
  {
    chainId,
    collateralId,
    txHash,
    newBalance,
  }: {
    chainId: number;
    collateralId: string;
    txHash: string;
    newBalance: bigint;
  },
): Promise<void> {
  const [accumulator, pending] = await Promise.all([
    loadStabilityPoolLossAccumulator(context, chainId, collateralId),
    loadPendingStabilityPoolConsumption(context, chainId, txHash, collateralId),
  ]);
  context.StabilityPoolLossAccumulator.set({
    ...accumulator,
    totalBoldDeposits: newBalance,
  });
  if (pending !== undefined) {
    context.PendingStabilityPoolConsumption.set({
      ...pending,
      totalAfter: newBalance,
      stableOut:
        pending.totalBefore > newBalance
          ? pending.totalBefore - newBalance
          : 0n,
    });
  }
}

export async function classifyPendingStabilityPoolConsumption(
  context: StabilityPoolLossContext,
  {
    chainId,
    collateralId,
    txHash,
    source,
  }: {
    chainId: number;
    collateralId: string;
    txHash: string;
    source: StabilityPoolLossSource;
  },
): Promise<void> {
  const pending = await loadPendingStabilityPoolConsumption(
    context,
    chainId,
    txHash,
    collateralId,
  );
  if (pending === undefined) return;
  const scale = await context.StabilityPoolLossScale.get(
    scaleId(collateralId, pending.scaleBefore),
  );
  const currentScale =
    scale ?? makeScale(chainId, collateralId, pending.scaleBefore);
  const lossDelta = lossProductDelta(pending);
  context.StabilityPoolLossScale.set({
    ...currentScale,
    rebalanceLossSum:
      source === "rebalance"
        ? currentScale.rebalanceLossSum + lossDelta
        : currentScale.rebalanceLossSum,
    liquidationLossSum:
      source === "liquidation"
        ? currentScale.liquidationLossSum + lossDelta
        : currentScale.liquidationLossSum,
  });
  context.PendingStabilityPoolConsumption.deleteUnsafe(pending.id);
}

export async function preloadPendingStabilityPoolConsumptionClassification(
  context: StabilityPoolLossContext,
  chainId: number,
  txHash: string,
  collateralId: string,
): Promise<void> {
  const pending = await loadPendingStabilityPoolConsumption(
    context,
    chainId,
    txHash,
    collateralId,
  );
  if (pending !== undefined) {
    await context.StabilityPoolLossScale.get(
      scaleId(collateralId, pending.scaleBefore),
    );
  }
}

export async function loadLossScalesForDepositor(
  context: Pick<StabilityPoolLossContext, "StabilityPoolLossScale">,
  depositor: StabilityPoolDepositor | undefined,
): Promise<Array<StabilityPoolLossScale | undefined>> {
  if (
    depositor === undefined ||
    depositor.lastTouchedDeposit === 0n ||
    depositor.depositSnapshotP === 0n
  ) {
    return [];
  }
  const reads: Array<Promise<StabilityPoolLossScale | undefined>> = [];
  for (let offset = 0n; offset <= MAX_SCALE_FACTOR_EXPONENT; offset += 1n) {
    reads.push(
      context.StabilityPoolLossScale.get(
        scaleId(
          depositor.collateralId,
          depositor.depositSnapshotScale + offset,
        ),
      ),
    );
  }
  return Promise.all(reads);
}

export function deriveSourceLossSinceSnapshot({
  depositor,
  scales,
  emittedLoss,
}: {
  depositor: StabilityPoolDepositor | undefined;
  scales: Array<StabilityPoolLossScale | undefined>;
  emittedLoss: bigint;
}): StabilityPoolSourceLoss {
  if (depositor === undefined || emittedLoss === 0n) {
    return { rebalance: 0n, liquidation: 0n };
  }
  const raw = {
    rebalance: sourceLossForDepositor(depositor, scales, "rebalance"),
    liquidation: sourceLossForDepositor(depositor, scales, "liquidation"),
  };
  return reconcileSourceLoss(raw, emittedLoss);
}

export function nextStabilityPoolLossSnapshots({
  scale,
}: {
  scale: StabilityPoolLossScale;
}): {
  rebalanceLossSnapshot: bigint;
  liquidationLossSnapshot: bigint;
} {
  return {
    rebalanceLossSnapshot: scale.rebalanceLossSum,
    liquidationLossSnapshot: scale.liquidationLossSum,
  };
}

const lossProductDelta = (pending: PendingStabilityPoolConsumption): bigint => {
  if (
    pending.pBefore <= pending.pAfter &&
    pending.scaleBefore === pending.scaleAfter
  ) {
    return 0n;
  }
  if (pending.scaleAfter <= pending.scaleBefore) {
    return pending.pBefore > pending.pAfter
      ? pending.pBefore - pending.pAfter
      : 0n;
  }
  const scaleDiff = pending.scaleAfter - pending.scaleBefore;
  if (scaleDiff > MAX_SCALE_FACTOR_EXPONENT) return pending.pBefore;
  const adjustedAfter = pending.pAfter / SCALE_FACTOR ** scaleDiff;
  return pending.pBefore > adjustedAfter ? pending.pBefore - adjustedAfter : 0n;
};

const sourceLossForDepositor = (
  depositor: StabilityPoolDepositor,
  scales: Array<StabilityPoolLossScale | undefined>,
  source: StabilityPoolLossSource,
): bigint => {
  let normalizedLoss = 0n;
  for (let offset = 0; offset < scales.length; offset += 1) {
    const scale = scales[offset];
    const sum =
      source === "rebalance"
        ? (scale?.rebalanceLossSum ?? 0n)
        : (scale?.liquidationLossSum ?? 0n);
    const snapshot =
      offset === 0
        ? source === "rebalance"
          ? depositor.rebalanceLossSnapshot
          : depositor.liquidationLossSnapshot
        : 0n;
    const delta = sum > snapshot ? sum - snapshot : 0n;
    normalizedLoss +=
      offset === 0 ? delta : delta / SCALE_FACTOR ** BigInt(offset);
  }
  return (
    (depositor.lastTouchedDeposit * normalizedLoss) / depositor.depositSnapshotP
  );
};

const reconcileSourceLoss = (
  raw: StabilityPoolSourceLoss,
  emittedLoss: bigint,
): StabilityPoolSourceLoss => {
  const rawTotal = raw.rebalance + raw.liquidation;
  if (rawTotal === emittedLoss) return raw;
  if (rawTotal === 0n) {
    return { rebalance: emittedLoss, liquidation: 0n };
  }
  if (rawTotal < emittedLoss) {
    const residual = emittedLoss - rawTotal;
    if (raw.liquidation > raw.rebalance) {
      return {
        rebalance: raw.rebalance,
        liquidation: raw.liquidation + residual,
      };
    }
    return {
      rebalance: raw.rebalance + residual,
      liquidation: raw.liquidation,
    };
  }
  const rebalance = (raw.rebalance * emittedLoss) / rawTotal;
  return {
    rebalance,
    liquidation: emittedLoss - rebalance,
  };
};
