import { EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventHandler,
  type EventHandlerConfig,
} from "../event-handler-factory.js";
import {
  EventType,
  type ProposalCreatedEvent,
  type QuicknodeEvent,
} from "../types.js";

const { mockSendDiscordNotification, mockSendTelegramNotification } =
  vi.hoisted(() => ({
    mockSendDiscordNotification: vi.fn(),
    mockSendTelegramNotification: vi.fn(),
  }));

vi.mock("../../event-notifications/send-discord-notification.js", () => ({
  default: mockSendDiscordNotification,
}));

vi.mock("../../event-notifications/send-telegram-notification.js", () => ({
  default: mockSendTelegramNotification,
}));

const event: QuicknodeEvent & ProposalCreatedEvent = {
  address: "0x47036d78bb3169b4f5560dd77bf93f4412a59852",
  blockHash: "0xdeadbeef",
  blockNumber: "1",
  logIndex: "0",
  name: EventType.ProposalCreated,
  transactionHash: "0xabc",
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
};

const config: EventHandlerConfig<typeof event> = {
  eventType: EventType.ProposalCreated,
  validateEvent: (value: unknown): value is typeof event =>
    (value as QuicknodeEvent).name === EventType.ProposalCreated,
  getDiscordMessage: () => ({
    content: "Proposal created",
    embed: new EmbedBuilder().setTitle("Proposal created"),
  }),
  getTelegramMessage: () => ({
    toHTML: (title: string) => `<b>${title}</b>`,
  }),
  emoji: "GOV",
};

interface StructuredErrorLog {
  severity: string;
  message: string;
}

function loggedErrors(): StructuredErrorLog[] {
  const calls = vi.mocked(console.error).mock.calls as unknown[][];
  return calls.map((call) => {
    const line = call[0];
    if (typeof line !== "string") {
      throw new TypeError("Expected console.error to receive a string log");
    }
    return JSON.parse(line) as StructuredErrorLog;
  });
}

describe("createEventHandler notification failures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mockSendDiscordNotification.mockResolvedValue(undefined);
    mockSendTelegramNotification.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSendDiscordNotification.mockClear();
    mockSendTelegramNotification.mockClear();
  });

  it("logs Discord send failures as structured ERROR entries and still sends Telegram", async () => {
    mockSendDiscordNotification.mockRejectedValueOnce(
      new Error("discord unavailable"),
    );
    const handler = createEventHandler(config);

    await handler(event);

    expect(mockSendDiscordNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramNotification).toHaveBeenCalledOnce();
    const errors = loggedErrors();
    expect(errors).toHaveLength(1);
    const [entry] = errors;
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toContain(
      "Failed to send Discord notification for ProposalCreated event:",
    );
    expect(entry.message).toContain("Error: discord unavailable");
  });

  it("logs Telegram send failures as structured ERROR entries", async () => {
    mockSendTelegramNotification.mockRejectedValueOnce(
      new Error("telegram unavailable"),
    );
    const handler = createEventHandler(config);

    await handler(event);

    expect(mockSendDiscordNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramNotification).toHaveBeenCalledOnce();
    const errors = loggedErrors();
    expect(errors).toHaveLength(1);
    const [entry] = errors;
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toContain(
      "Failed to send Telegram notification for ProposalCreated event:",
    );
    expect(entry.message).toContain("Error: telegram unavailable");
  });
});
