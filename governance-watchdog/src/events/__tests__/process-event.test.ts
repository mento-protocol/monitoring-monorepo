import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventType,
  type ProposalCanceledEvent,
  type ProposalCreatedEvent,
  type ProposalExecutedEvent,
  type ProposalQueuedEvent,
  type QuicknodeEvent,
} from "../types.js";

// Mock the event registry so we can verify handler calls
const mockHandler = vi.fn().mockResolvedValue(undefined);
const mockHealthCheckHandler = vi.fn();

vi.mock("../registry.js", () => ({
  eventRegistry: {
    getHandler: vi.fn(() => mockHandler),
    getSpecialHandler: vi.fn(() => mockHealthCheckHandler),
  },
}));

// Base fields shared by all QuicknodeEvents
const BASE_EVENT = {
  blockHash: "0xdeadbeef",
  blockNumber: "1",
  logIndex: "0",
  transactionHash: "0xabc",
} as const;

/** Build a typed ProposalCreated event from a given address */
const makeProposalCreated = (
  address: string,
): QuicknodeEvent & ProposalCreatedEvent => ({
  ...BASE_EVENT,
  name: EventType.ProposalCreated,
  address,
  proposalId: BigInt(1),
  proposer: "0x1234567890123456789012345678901234567890",
  calldatas: "0x",
  description: "{}",
  endBlock: BigInt(100),
  signatures: "",
  startBlock: BigInt(1),
  targets: "0x1234567890123456789012345678901234567890",
  values: BigInt(0),
  version: 1,
});

const makeProposalQueued = (
  address: string,
): QuicknodeEvent & ProposalQueuedEvent => ({
  ...BASE_EVENT,
  name: EventType.ProposalQueued,
  address,
  proposalId: BigInt(1),
  eta: BigInt(9999),
});

const makeProposalExecuted = (
  address: string,
): QuicknodeEvent & ProposalExecutedEvent => ({
  ...BASE_EVENT,
  name: EventType.ProposalExecuted,
  address,
  proposalId: BigInt(1),
});

const makeProposalCanceled = (
  address: string,
): QuicknodeEvent & ProposalCanceledEvent => ({
  ...BASE_EVENT,
  name: EventType.ProposalCanceled,
  address,
  proposalId: BigInt(1),
});

describe("processEvent — governor address guard", () => {
  const GOVERNOR_ADDRESS = "0x47036d78bb3169b4f5560dd77bf93f4412a59852";
  const OTHER_ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes ProposalCreated from the canonical governor address", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalCreated(GOVERNOR_ADDRESS));
    expect(mockHandler).toHaveBeenCalledOnce();
  });

  it("skips ProposalCreated from a non-governor address", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalCreated(OTHER_ADDRESS));
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("skips ProposalQueued from a non-governor address", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalQueued(OTHER_ADDRESS));
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("skips ProposalExecuted from a non-governor address", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalExecuted(OTHER_ADDRESS));
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("skips ProposalCanceled from a non-governor address", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalCanceled(OTHER_ADDRESS));
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("handles mixed-case governor address (case-insensitive comparison)", async () => {
    const { processEvent } = await import("../process-event.js");
    await processEvent(makeProposalCreated(GOVERNOR_ADDRESS.toUpperCase()));
    expect(mockHandler).toHaveBeenCalledOnce();
  });

  it("does not apply address guard to MedianUpdated events", async () => {
    const { processEvent } = await import("../process-event.js");
    const event: QuicknodeEvent = {
      ...BASE_EVENT,
      name: EventType.MedianUpdated,
      address: OTHER_ADDRESS,
      token: "0x765de816845861e75a25fca122bb6898b8b1282a", // gitleaks:allow
      value: BigInt(1),
    };
    await processEvent(event);
    expect(mockHealthCheckHandler).toHaveBeenCalledOnce();
    expect(mockHandler).not.toHaveBeenCalled();
  });
});
