/**
 * Narrow structural subsets of the generated handler context, one per
 * Wormhole NTT handler file. Keeps each handler's API surface focused on
 * the entities it actually touches; the full `generated` HandlerContext is
 * much wider.
 */
import type {
  BridgeTransfer,
  BridgeAttestation,
  BridgeDailySnapshot,
  BridgeBridger,
  WormholeDestPending,
  WormholeTransferDetail,
  WormholeTransferPending,
  wormholeNttManager as WormholeNttManagerEntity,
} from "generated";

type EntityRW<T> = {
  get: (id: string) => Promise<T | undefined>;
  set: (entity: T) => void;
};

type EphemeralEntityRW<T> = EntityRW<T> & {
  deleteUnsafe?: (id: string) => void;
};

export type WormholeHandlerContext = {
  BridgeTransfer: EntityRW<BridgeTransfer>;
  WormholeTransferDetail: EntityRW<WormholeTransferDetail>;
  WormholeNttManager: EntityRW<WormholeNttManagerEntity>;
  WormholeTransferPending: EphemeralEntityRW<WormholeTransferPending>;
  WormholeDestPending: EphemeralEntityRW<WormholeDestPending>;
  BridgeAttestation: EntityRW<BridgeAttestation>;
  BridgeDailySnapshot: EntityRW<BridgeDailySnapshot>;
  BridgeBridger: EntityRW<BridgeBridger>;
};

/** The transceiver handler only writes scratch — no reads, no deletes. */
export type WormholeTransceiverContext = {
  WormholeDestPending: Pick<EphemeralEntityRW<WormholeDestPending>, "set">;
};
