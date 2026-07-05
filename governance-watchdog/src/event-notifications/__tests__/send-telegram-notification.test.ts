import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => {
  const mockConfig: {
    TELEGRAM_BOT_TOKEN_SECRET_ID: string;
    TELEGRAM_CHAT_ID: string;
    TELEGRAM_TEST_CHAT_ID: string | undefined;
  } = {
    TELEGRAM_BOT_TOKEN_SECRET_ID: "telegram-bot-token",
    TELEGRAM_CHAT_ID: "prod-chat-id",
    TELEGRAM_TEST_CHAT_ID: "test-chat-id",
  };
  return { mockConfig };
});

vi.mock("../../config.js", () => ({ default: mockConfig }));

const mockGetSecret = vi.fn();
vi.mock("../../utils/get-secret.js", () => ({ default: mockGetSecret }));

function telegramResponse(status: number): Response {
  return new Response(JSON.stringify({ description: "error" }), { status });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function requestChatId(fetchMock: FetchMock, callIndex: number): string {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  const body = init?.body;
  if (typeof body !== "string") {
    throw new TypeError("Expected the fetch call to send a JSON string body");
  }
  const parsed = JSON.parse(body) as { chat_id: string };
  return parsed.chat_id;
}

describe("sendTelegramNotification", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    mockConfig.TELEGRAM_CHAT_ID = "prod-chat-id";
    mockConfig.TELEGRAM_TEST_CHAT_ID = "test-chat-id";
    mockGetSecret.mockResolvedValue("bot-token");
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    vi.unstubAllGlobals();
  });

  it("delivers exactly once when a 5xx failure is followed by success", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(telegramResponse(503))
      .mockResolvedValueOnce(telegramResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await sendTelegramNotification("<b>hello</b>");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-OK response and does not retry a terminal 4xx", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(400));
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await expect(sendTelegramNotification("<b>hello</b>")).rejects.toThrow(
      "Failed to send telegram notification:",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a 429 response (retry_after can exceed our retry budget)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(429));
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await expect(sendTelegramNotification("<b>hello</b>")).rejects.toThrow(
      "Failed to send telegram notification:",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("selects the production chat id by default", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await sendTelegramNotification("<b>hello</b>");

    expect(requestChatId(fetchMock, 0)).toBe("prod-chat-id");
  });

  it("selects the test chat id in development", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(telegramResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await sendTelegramNotification("<b>hello</b>");

    expect(requestChatId(fetchMock, 0)).toBe("test-chat-id");
  });

  it("throws without sending when the dev test chat id is missing", async () => {
    process.env.NODE_ENV = "development";
    mockConfig.TELEGRAM_TEST_CHAT_ID = undefined;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { default: sendTelegramNotification } =
      await import("../send-telegram-notification.js");

    await expect(sendTelegramNotification("<b>hello</b>")).rejects.toThrow(
      "TELEGRAM_TEST_CHAT_ID env var is not set",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
