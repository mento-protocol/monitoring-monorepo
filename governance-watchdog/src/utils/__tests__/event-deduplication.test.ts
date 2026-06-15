import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventType,
  type ProposalCreatedEvent,
  type QuicknodeEvent,
} from "../../events/types.js";

vi.mock("../../event-notifications/send-discord-notification.js", () => ({
  default: vi.fn(),
}));

vi.mock("../../event-notifications/send-telegram-notification.js", () => ({
  default: vi.fn(),
}));

const BASE_EVENT = {
  address: "0x47036d78bb3169b4f5560dd77bf93f4412a59852",
  blockHash: "0xdeadbeef",
  blockNumber: "1",
  logIndex: "0",
  transactionHash: "0xabc",
} as const;

function makeProposalCreated(
  overrides: Partial<QuicknodeEvent & ProposalCreatedEvent> = {},
): QuicknodeEvent & ProposalCreatedEvent {
  return {
    ...BASE_EVENT,
    name: EventType.ProposalCreated,
    proposalId: 1n,
    proposer: "0x1234567890123456789012345678901234567890",
    calldatas: "0x",
    description: "{}",
    endBlock: 100n,
    signatures: "",
    startBlock: 1n,
    targets: "0x1234567890123456789012345678901234567890",
    values: 0n,
    version: 1,
    ...overrides,
  };
}

async function loadDeduplication() {
  const { initializeEventRegistry } = await import("../../events/registry.js");
  initializeEventRegistry();
  return import("../event-deduplication.js");
}

describe("event deduplication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the same event duplicate inside the deduplication window", async () => {
    const { isDuplicate } = await loadDeduplication();
    const event = makeProposalCreated();

    expect(isDuplicate(event)).toBe(false);
    expect(isDuplicate(event)).toBe(true);
  });

  it("keeps transaction hash and log index in the event id", async () => {
    const { isDuplicate } = await loadDeduplication();
    const first = makeProposalCreated();

    expect(isDuplicate(first)).toBe(false);
    expect(
      isDuplicate(
        makeProposalCreated({ transactionHash: "0xdef", proposalId: 1n }),
      ),
    ).toBe(false);
    expect(
      isDuplicate(makeProposalCreated({ logIndex: "1", proposalId: 1n })),
    ).toBe(false);
  });

  it("allows the same event again after the deduplication window", async () => {
    const { isDuplicate } = await loadDeduplication();
    const event = makeProposalCreated();

    expect(isDuplicate(event)).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(isDuplicate(event)).toBe(false);
  });

  it("falls back to transaction data for unregistered event names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { isDuplicate } = await loadDeduplication();
    const event = {
      ...BASE_EVENT,
      name: EventType.Unknown,
    } as unknown as QuicknodeEvent;

    expect(isDuplicate(event)).toBe(false);
    expect(isDuplicate(event)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      `No config found for event type: ${EventType.Unknown}`,
    );
  });

  it("cleans up expired entries once the cache exceeds its size limit", async () => {
    const { getCacheSize, isDuplicate } = await loadDeduplication();

    expect(isDuplicate(makeProposalCreated({ proposalId: 0n }))).toBe(false);
    vi.advanceTimersByTime(61_000);
    for (let index = 1; index <= 100; index++) {
      expect(
        isDuplicate(
          makeProposalCreated({
            proposalId: BigInt(index),
            transactionHash: `0x${index.toString(16)}`,
            logIndex: String(index),
          }),
        ),
      ).toBe(false);
    }

    expect(getCacheSize()).toBe(100);
  });
});
