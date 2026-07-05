import { EmbedBuilder, HTTPError } from "discord.js";
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

// Exercises the REAL send-discord-notification.js / send-telegram-notification.js
// modules (including the retry logic) end to end, mocking only the transport
// (discord.js's WebhookClient and global fetch). This is deliberately
// different from event-handler-factory.test.ts, which mocks the send
// functions themselves to isolate factory-level behavior.

const { mockSend, MockWebhookClient, mockDiscordConfig } = vi.hoisted(() => {
  const mockSend = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  class MockWebhookClient {
    send(...args: unknown[]): Promise<unknown> {
      return mockSend(...args);
    }
  }
  const mockDiscordConfig = {
    DISCORD_WEBHOOK_URL_SECRET_ID: "discord-webhook-url",
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: "discord-test-webhook-url",
  };
  return { mockSend, MockWebhookClient, mockDiscordConfig };
});

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return { ...actual, WebhookClient: MockWebhookClient };
});

vi.mock("../../config.js", () => ({
  default: {
    ...mockDiscordConfig,
    TELEGRAM_BOT_TOKEN_SECRET_ID: "telegram-bot-token",
    TELEGRAM_CHAT_ID: "prod-chat-id",
    TELEGRAM_TEST_CHAT_ID: "test-chat-id",
  },
}));

vi.mock("../../utils/get-secret.js", () => ({
  default: vi.fn().mockResolvedValue("secret-value"),
}));

function telegramResponse(status: number): Response {
  return new Response(JSON.stringify({ description: "ok" }), { status });
}

function make5xxError(): HTTPError {
  return new HTTPError(
    503,
    "Service Unavailable",
    "POST",
    "https://discord.com/api/webhooks/1/token",
    {},
  );
}

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

describe("createEventHandler with the real retry-wrapped send functions", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exhausts Discord retries, logs ERROR with event context, and still delivers Telegram", async () => {
    mockSend.mockRejectedValue(make5xxError());
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const handler = createEventHandler(config);
    await handler(event);

    // Discord retried (1 initial + 2 retries = 3 attempts) then gave up.
    expect(mockSend).toHaveBeenCalledTimes(3);
    // Per-channel isolation: the real, retry-wrapped Telegram send still runs.
    expect(fetchMock).toHaveBeenCalledOnce();

    const errors = loggedErrors();
    expect(errors).toHaveLength(1);
    const [entry] = errors;
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toContain(
      "Failed to send Discord notification for ProposalCreated event:",
    );
  }, 10_000);

  it("delivers Discord successfully after a transient 5xx and does not log an error", async () => {
    mockSend
      .mockRejectedValueOnce(make5xxError())
      .mockResolvedValueOnce(undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const handler = createEventHandler(config);
    await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(loggedErrors()).toHaveLength(0);
  });
});
