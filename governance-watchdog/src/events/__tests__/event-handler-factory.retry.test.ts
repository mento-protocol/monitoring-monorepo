import { EmbedBuilder } from "@discordjs/builders";
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
// (global fetch). This is deliberately different from
// event-handler-factory.test.ts, which mocks the send functions themselves to
// isolate factory-level behavior.

const {
  mockDiscordConfig,
  mockDiscordFetch,
  mockGetSecret,
  mockTelegramFetch,
} = vi.hoisted(() => {
  const mockDiscordFetch = vi.fn<typeof fetch>();
  const mockGetSecret = vi.fn();
  const mockTelegramFetch = vi.fn<typeof fetch>();
  const mockDiscordConfig = {
    DISCORD_WEBHOOK_URL_SECRET_ID: "discord-webhook-url",
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: "discord-test-webhook-url",
  };
  return {
    mockDiscordConfig,
    mockDiscordFetch,
    mockGetSecret,
    mockTelegramFetch,
  };
});

vi.mock("../../config.js", () => ({
  default: {
    ...mockDiscordConfig,
    TELEGRAM_BOT_TOKEN_SECRET_ID: "telegram-bot-token",
    TELEGRAM_CHAT_ID: "prod-chat-id",
    TELEGRAM_TEST_CHAT_ID: "test-chat-id",
  },
}));

vi.mock("../../utils/get-secret.js", () => ({ default: mockGetSecret }));

function telegramResponse(status: number): Response {
  return new Response(JSON.stringify({ description: "ok" }), { status });
}

function discordResponse(status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify({ ok: false }), {
    status,
  });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/")) {
        return mockDiscordFetch(input, init);
      }
      return mockTelegramFetch(input, init);
    }),
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
    mockDiscordFetch.mockReset();
    mockGetSecret.mockImplementation((secretId: string) => {
      if (secretId === "discord-webhook-url") {
        return Promise.resolve("https://discord.com/api/webhooks/1/token");
      }
      return Promise.resolve("telegram-token");
    });
    mockTelegramFetch.mockReset();
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exhausts Discord retries, logs ERROR with event context, and still delivers Telegram", async () => {
    mockDiscordFetch.mockResolvedValue(discordResponse(503));
    mockTelegramFetch.mockResolvedValue(telegramResponse(200));

    const handler = createEventHandler(config);
    await handler(event);

    // Discord retried (1 initial + 2 retries = 3 attempts) then gave up.
    expect(mockDiscordFetch).toHaveBeenCalledTimes(3);
    // Per-channel isolation: the real, retry-wrapped Telegram send still runs.
    expect(mockTelegramFetch).toHaveBeenCalledOnce();

    const errors = loggedErrors();
    expect(errors).toHaveLength(1);
    const [entry] = errors;
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toContain(
      "Failed to send Discord notification for ProposalCreated event:",
    );
  }, 10_000);

  it("delivers Discord successfully after a transient 5xx and does not log an error", async () => {
    mockDiscordFetch
      .mockResolvedValueOnce(discordResponse(503))
      .mockResolvedValueOnce(discordResponse(204));
    mockTelegramFetch.mockResolvedValue(telegramResponse(200));

    const handler = createEventHandler(config);
    await handler(event);

    expect(mockDiscordFetch).toHaveBeenCalledTimes(2);
    expect(loggedErrors()).toHaveLength(0);
  });
});
