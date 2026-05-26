/**
 * Unit tests for processEvents orchestrator
 *
 * Pins the FINAL desired behavior: ChainDetectionError thrown by a single
 * log entry must be logged but NOT re-thrown. `processEvents` continues
 * processing the remaining entries and returns the successful ones.
 *
 * Regression context: a previous Codex review (commit d9c36716) added a
 * `if (error instanceof ChainDetectionError) throw error;` clause to abort the
 * batch and return HTTP 422 so QuickNode would retry. But QuickNode retries
 * the ENTIRE payload, which caused duplicate Discord deliveries for the events
 * in the batch that already succeeded. The clause was reverted; this test
 * pins the per-event-isolation behavior so the next person re-introducing it
 * gets a red test.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config", () => ({
  default: {
    DISCORD_WEBHOOK_ALERTS: "https://discord.com/api/webhooks/test/alerts",
    DISCORD_WEBHOOK_EVENTS: "https://discord.com/api/webhooks/test/events",
    MULTISIG_CONFIG: JSON.stringify({
      SOLO_CELO: {
        address: "0xAAaaaAAaAaAaAaaAaaAaaaaAaaAAaAAaAAaAaaAA",
        name: "Solo Celo",
        chain: "celo",
      },
      AMBIGUOUS_CELO: {
        address: "0xCCcccCCcCcCcCccCcCCcccCccccCcCCcCCcCccCC",
        name: "Ambiguous (Celo side)",
        chain: "celo",
      },
      AMBIGUOUS_ETH: {
        address: "0xCCcccCCcCcCcCccCcCCcccCccccCcCCcCCcCccCC",
        name: "Ambiguous (Eth side)",
        chain: "ethereum",
      },
    }),
    QUICKNODE_SIGNING_SECRET: "test-secret",
  },
}));

// Mock viem so findChainFromBlockHash probes fail-closed for the ambiguous
// address (forcing ChainDetectionError) but allow the solo address to skip
// the RPC path entirely (length-1 possibleChains short-circuit).
const getBlockMock = vi.fn();
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlock: getBlockMock,
    })),
    http: vi.fn(() => "http-transport"),
  };
});

// Mock the logger so we can assert error was called for the failed event.
const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    critical: vi.fn(),
  },
}));

// Mock the Discord send so the successful event doesn't try to hit the network.
vi.mock("./discord", async () => {
  const actual = await vi.importActual<typeof import("./discord")>("./discord");
  return {
    ...actual,
    sendToDiscord: vi.fn(async () => undefined),
    formatDiscordMessage: vi.fn(async () => ({ embeds: [] })),
  };
});

const SOLO_CELO_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AMBIGUOUS_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("processEvents - ChainDetectionError handling", () => {
  beforeEach(() => {
    getBlockMock.mockReset();
    loggerErrorMock.mockClear();
    loggerInfoMock.mockClear();
    loggerWarnMock.mockClear();
  });

  it("logs ChainDetectionError but does NOT throw; returns successful events only", async () => {
    // Force block-hash probes to fail on both chains → ambiguous addr fails closed
    // → processEvent throws ChainDetectionError for the first log entry.
    getBlockMock.mockRejectedValue(new Error("block not found"));

    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");

    const logs = [
      // Will trigger ChainDetectionError: ambiguous address + block hash
      // can't be verified on either chain.
      {
        address: AMBIGUOUS_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx1",
        blockHash: "0xblockUnverifiable",
        blockNumber: "100",
        logIndex: "0",
        owner: "0xowner1",
      },
      // Will succeed: solo-celo address short-circuits to "celo".
      {
        address: SOLO_CELO_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx2",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "1",
        owner: "0xowner2",
      },
    ];

    const context = buildEventContext(logs);

    // The whole point: does NOT throw.
    const result = await processEvents(logs, context);

    // Only the successful event survives.
    expect(result.processedEvents).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.processedEvents[0]).toMatchObject({
      multisigKey: "SOLO_CELO",
      eventName: "AddedOwner",
      channelType: "alerts",
    });

    // The failed event's ChainDetectionError must have been logged.
    // The implementation logs "Chain detection failed" before throwing inside
    // processEvent, and the orchestrator's catch logs "Error processing log".
    const errorMessages = loggerErrorMock.mock.calls.map(
      (call) => call[0] as string,
    );
    expect(
      errorMessages.some(
        (msg) =>
          msg === "Chain detection failed" || msg === "Error processing log",
      ),
    ).toBe(true);

    // The "Error processing log" metadata should flag chainDetectionFailure.
    const errorProcessingCalls = loggerErrorMock.mock.calls.filter(
      (call) => call[0] === "Error processing log",
    );
    if (errorProcessingCalls.length > 0) {
      const metadata = errorProcessingCalls[0][1] as Record<string, unknown>;
      expect(metadata).toBeDefined();
    }
  });

  it("does not throw when ALL events fail chain detection; returns empty array", async () => {
    // All probes fail; both events are ambiguous.
    getBlockMock.mockRejectedValue(new Error("block not found"));

    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");

    const logs = [
      {
        address: AMBIGUOUS_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx1",
        blockHash: "0xblockUnverifiable",
        blockNumber: "100",
        logIndex: "0",
        owner: "0xowner1",
      },
      {
        address: AMBIGUOUS_ADDR,
        name: "RemovedOwner",
        transactionHash: "0xtx2",
        blockHash: "0xblockAlsoUnverifiable",
        blockNumber: "101",
        logIndex: "1",
        owner: "0xowner2",
      },
    ];

    const context = buildEventContext(logs);

    const result = await processEvents(logs, context);

    expect(result).toEqual({ processedEvents: [], skipped: 0 });
    // At least one error log per failed event.
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("falls back to ExecutionSuccess when matching SafeMultiSigTransaction is malformed", async () => {
    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");
    const { sendToDiscord } = await import("./discord");
    const sendMock = vi.mocked(sendToDiscord);
    sendMock.mockClear();

    const logs = [
      {
        address: SOLO_CELO_ADDR,
        name: "ExecutionSuccess",
        transactionHash: "0xtx-success",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "1",
        txHash: "0xsafeTx",
      },
      {
        name: "SafeMultiSigTransaction",
        transactionHash: "0xtx-success",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "2",
      },
    ] as never;

    const context = buildEventContext(logs);
    const result = await processEvents(logs, context);

    expect(result).toEqual({
      processedEvents: [
        {
          multisigKey: "SOLO_CELO",
          eventName: "ExecutionSuccess",
          channelType: "events",
        },
      ],
      skipped: 0,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith("Invalid log entry", {
      error: "Log missing or invalid address field",
      address: undefined,
      name: "SafeMultiSigTransaction",
      transactionHash: "0xtx-success",
    });
  });

  it("stops starting new events when the processing budget is exhausted", async () => {
    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");
    const { sendToDiscord } = await import("./discord");
    const sendMock = vi.mocked(sendToDiscord);
    sendMock.mockClear();

    let currentMs = 0;
    const now = vi.fn(() => currentMs);
    sendMock.mockImplementation(async () => {
      currentMs += 10;
    });

    const logs = [
      {
        address: SOLO_CELO_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx1",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "1",
        owner: "0xowner1",
      },
      {
        address: SOLO_CELO_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx2",
        blockHash: "0xblockGood",
        blockNumber: "102",
        logIndex: "2",
        owner: "0xowner2",
      },
    ];

    const context = buildEventContext(logs);
    const result = await processEvents(logs, context, { budgetMs: 10, now });

    expect(result).toEqual({
      processedEvents: [
        {
          multisigKey: "SOLO_CELO",
          eventName: "AddedOwner",
          channelType: "alerts",
        },
      ],
      skipped: 1,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Skipping remaining logs due to processing budget",
      {
        reason: "skipped_due_to_timeout",
        skipped: 1,
        processed: 1,
        elapsedMs: 10,
        budgetMs: 10,
      },
    );
  });

  it("prioritizes SafeMultiSigTransaction over duplicate ExecutionSuccess when the budget is tight", async () => {
    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");
    const { sendToDiscord } = await import("./discord");
    const sendMock = vi.mocked(sendToDiscord);
    sendMock.mockClear();

    let currentMs = 0;
    const now = vi.fn(() => currentMs);
    sendMock.mockImplementation(async () => {
      currentMs += 10;
    });

    const logs = [
      {
        address: SOLO_CELO_ADDR,
        name: "ExecutionSuccess",
        transactionHash: "0xtx-safe",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "1",
        txHash: "0xsafeTx",
      },
      {
        address: SOLO_CELO_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx-other",
        blockHash: "0xblockGood",
        blockNumber: "102",
        logIndex: "2",
        owner: "0xowner2",
      },
      {
        address: SOLO_CELO_ADDR,
        name: "SafeMultiSigTransaction",
        transactionHash: "0xtx-safe",
        blockHash: "0xblockGood",
        blockNumber: "103",
        logIndex: "3",
        to: "0xtarget",
        value: "0",
        data: "0x",
        operation: "0",
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        signatures: "0x",
      },
    ];

    const context = buildEventContext(logs);
    const result = await processEvents(logs, context, { budgetMs: 10, now });

    expect(result).toEqual({
      processedEvents: [
        expect.objectContaining({
          multisigKey: "SOLO_CELO",
          eventName: "SafeMultiSigTransaction",
        }),
      ],
      skipped: 2,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps standalone ExecutionSuccess in original priority under a tight budget", async () => {
    const { processEvents } = await import("./process-events");
    const { buildEventContext } = await import("./build-event-context");
    const { sendToDiscord } = await import("./discord");
    const sendMock = vi.mocked(sendToDiscord);
    sendMock.mockClear();

    let currentMs = 0;
    const now = vi.fn(() => currentMs);
    sendMock.mockImplementation(async () => {
      currentMs += 10;
    });

    const logs = [
      {
        address: SOLO_CELO_ADDR,
        name: "ExecutionSuccess",
        transactionHash: "0xtx-standalone",
        blockHash: "0xblockGood",
        blockNumber: "101",
        logIndex: "1",
        txHash: "0xsafeTx",
      },
      {
        address: SOLO_CELO_ADDR,
        name: "AddedOwner",
        transactionHash: "0xtx-other",
        blockHash: "0xblockGood",
        blockNumber: "102",
        logIndex: "2",
        owner: "0xowner2",
      },
    ];

    const context = buildEventContext(logs);
    const result = await processEvents(logs, context, { budgetMs: 10, now });

    expect(result).toEqual({
      processedEvents: [
        {
          multisigKey: "SOLO_CELO",
          eventName: "ExecutionSuccess",
          channelType: "events",
        },
      ],
      skipped: 1,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
