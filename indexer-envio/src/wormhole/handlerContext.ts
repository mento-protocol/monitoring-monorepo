/**
 * Narrow structural types for the handler `context` across the Wormhole NTT
 * handlers. These are hand-rolled rather than pulled from `generated` because:
 *
 *   - The generated `HandlerContext` is wide — every entity the indexer
 *     tracks. Hand-rolled subsets give each handler a focused API surface.
 *   - The entity row shapes are shared across multiple handler files
 *     (source-side `nttManager.ts`, dest-side `wormholeTransceiver.ts`), so
 *     defining them once here avoids drift when a schema field is added.
 *
 * Update this file in lockstep with `schema.graphql` entity definitions.
 */
import type {
  BridgeTransfer,
  BridgeAttestation,
  BridgeDailySnapshot,
  BridgeBridger,
  WormholeTransferDetail,
  wormholeNttManager as WormholeNttManagerEntity,
} from "generated";

export type WormholeTransferPendingRow = {
  id: string;
  chainId: number;
  txHash: string;
  nttManager: string;
  sender: string;
  recipient: string;
  refundAddress: string;
  amount: bigint;
  fee: bigint;
  recipientWormholeChainId: number;
  msgSequence: bigint;
  sentBlock: bigint;
  sentTimestamp: bigint;
};

export type WormholeDestPendingRow = {
  id: string;
  chainId: number;
  txHash: string;
  transceiverDigest: string;
  sourceChainId: number;
  sourceTransceiver: string;
  sourceWormholeChainId: number;
  msgSequence: bigint;
  destTransceiver: string;
  blockTimestamp: bigint;
};

type EntityRW<T> = {
  get: (id: string) => Promise<T | undefined>;
  set: (entity: T) => void;
};

type EphemeralEntityRW<T> = EntityRW<T> & {
  deleteUnsafe?: (id: string) => void;
};

/**
 * Wide handler context used by NttManager event handlers. Covers every
 * entity read or written on the source + dest paths.
 */
export type WormholeHandlerContext = {
  BridgeTransfer: EntityRW<BridgeTransfer>;
  WormholeTransferDetail: EntityRW<WormholeTransferDetail>;
  WormholeNttManager: EntityRW<WormholeNttManagerEntity>;
  WormholeTransferPending: EphemeralEntityRW<WormholeTransferPendingRow>;
  WormholeDestPending: EphemeralEntityRW<WormholeDestPendingRow>;
  BridgeAttestation: EntityRW<BridgeAttestation>;
  BridgeDailySnapshot: EntityRW<BridgeDailySnapshot>;
  BridgeBridger: EntityRW<BridgeBridger>;
};

/** Narrow context for the transceiver handler — it only writes scratch. */
export type WormholeTransceiverContext = {
  WormholeDestPending: Pick<EphemeralEntityRW<WormholeDestPendingRow>, "set">;
};
