export type ScratchDrainEvent = {
  chainId: number;
  transaction: { hash: string };
  logIndex: number;
};

export type ScratchEntity = "WormholeTransferPending" | "WormholeDestPending";

type ScratchLogger = {
  log: {
    warn: (message: string) => void;
  };
};

export function formatUnmatchedScratchDrainWarning(
  event: ScratchDrainEvent,
  scratchEntity: ScratchEntity,
): string {
  return (
    `[wormhole] unmatched scratch row drain for ${scratchEntity} ` +
    `(chain=${event.chainId} txHash=${event.transaction.hash} ` +
    `logIndex=${event.logIndex}); ` +
    "WormholeTransferPending/WormholeDestPending should be 0 in steady state."
  );
}

export function warnUnmatchedScratchDrain(
  context: ScratchLogger,
  event: ScratchDrainEvent,
  scratchEntity: ScratchEntity,
): void {
  context.log.warn(formatUnmatchedScratchDrainWarning(event, scratchEntity));
}
