import type {
  EventProcessor,
  MockDb,
  MockEventData,
} from "./indexerTestHarness.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_FACTORY = "0x00000000000000000000000000000000000000cc";
const DEFAULT_IMPLEMENTATION = "0x00000000000000000000000000000000000000bc";
const DEFAULT_TOKEN0 = "0x0000000000000000000000000000000000000003";
const DEFAULT_TOKEN1 = "0x0000000000000000000000000000000000000004";

export function createMockEventData(args: {
  chainId?: number;
  logIndex?: number;
  srcAddress?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  transaction?: Record<string, unknown>;
}): MockEventData {
  const data: MockEventData = {
    chainId: args.chainId ?? 42220,
    logIndex: args.logIndex ?? 0,
    srcAddress: args.srcAddress ?? ZERO_ADDRESS,
    block: {
      number: args.blockNumber ?? 1,
      timestamp: args.blockTimestamp ?? 1,
    },
  };
  if (args.transaction) data.transaction = args.transaction;
  return data;
}

export async function seedFpmmPoolFixture<Db extends MockDb>(
  mockDb: Db,
  FPMMDeployed: EventProcessor<unknown, Db>,
  args: {
    chainId?: number;
    token0?: string;
    token1?: string;
    poolAddress: string;
    implementation?: string;
    factoryAddress?: string;
    logIndex?: number;
    blockNumber?: number;
    blockTimestamp?: number;
  },
): Promise<Db> {
  const event = FPMMDeployed.createMockEvent({
    token0: args.token0 ?? DEFAULT_TOKEN0,
    token1: args.token1 ?? DEFAULT_TOKEN1,
    fpmmProxy: args.poolAddress,
    fpmmImplementation: args.implementation ?? DEFAULT_IMPLEMENTATION,
    mockEventData: createMockEventData({
      chainId: args.chainId,
      logIndex: args.logIndex,
      srcAddress: args.factoryAddress ?? DEFAULT_FACTORY,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    }),
  });
  return FPMMDeployed.processEvent({ event, mockDb });
}
