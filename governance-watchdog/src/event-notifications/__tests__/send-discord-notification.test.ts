import { EmbedBuilder, HTTPError, RateLimitError } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, mockWebhookClientCtor, MockWebhookClient, mockConfig } =
  vi.hoisted(() => {
    const mockSend = vi.fn<(...args: unknown[]) => Promise<unknown>>();
    const mockWebhookClientCtor =
      vi.fn<(data: unknown, options?: unknown) => void>();
    class MockWebhookClient {
      constructor(data: unknown, options?: unknown) {
        mockWebhookClientCtor(data, options);
      }
      send(...args: unknown[]): Promise<unknown> {
        return mockSend(...args);
      }
    }
    const mockConfig: {
      DISCORD_WEBHOOK_URL_SECRET_ID: string;
      DISCORD_TEST_WEBHOOK_URL_SECRET_ID: string | undefined;
    } = {
      DISCORD_WEBHOOK_URL_SECRET_ID: "discord-webhook-url",
      DISCORD_TEST_WEBHOOK_URL_SECRET_ID: "discord-test-webhook-url",
    };
    return { mockSend, mockWebhookClientCtor, MockWebhookClient, mockConfig };
  });

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return { ...actual, WebhookClient: MockWebhookClient };
});

const mockGetSecret = vi.fn();
vi.mock("../../utils/get-secret.js", () => ({ default: mockGetSecret }));

vi.mock("../../config.js", () => ({ default: mockConfig }));

function make5xxError(status = 503): HTTPError {
  return new HTTPError(
    status,
    "Service Unavailable",
    "POST",
    "https://discord.com/api/webhooks/1/token",
    {},
  );
}

const embed = new EmbedBuilder().setTitle("Proposal created");

describe("sendDiscordNotification", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    mockConfig.DISCORD_WEBHOOK_URL_SECRET_ID = "discord-webhook-url";
    mockConfig.DISCORD_TEST_WEBHOOK_URL_SECRET_ID = "discord-test-webhook-url";
    mockGetSecret.mockResolvedValue("https://discord.com/api/webhooks/1/token");
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("delivers exactly once when a 5xx failure is followed by success", async () => {
    mockSend
      .mockRejectedValueOnce(make5xxError(503))
      .mockResolvedValueOnce(undefined);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal 4xx failure", async () => {
    const terminal = make5xxError(400);
    mockSend.mockRejectedValue(terminal);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toBe(
      terminal,
    );
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("does not retry a RateLimitError (discord.js already queues 429s internally)", async () => {
    const rateLimitError = new RateLimitError({
      global: false,
      hash: "hash",
      limit: 5,
      majorParameter: "1",
      method: "POST",
      retryAfter: 1000,
      route: "/webhooks/1/token",
      sublimitTimeout: 0,
      timeToReset: 1000,
      url: "https://discord.com/api/webhooks/1/token",
      scope: "user",
    });
    mockSend.mockRejectedValue(rateLimitError);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toBe(
      rateLimitError,
    );
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("selects the production webhook secret by default", async () => {
    mockSend.mockResolvedValue(undefined);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(mockGetSecret).toHaveBeenCalledWith("discord-webhook-url");
  });

  it("selects the test webhook secret in development", async () => {
    process.env.NODE_ENV = "development";
    mockSend.mockResolvedValue(undefined);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(mockGetSecret).toHaveBeenCalledWith("discord-test-webhook-url");
  });

  it("disables discord.js's own internal REST retries so this module owns the retry budget", async () => {
    mockSend.mockResolvedValue(undefined);
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    const options = mockWebhookClientCtor.mock.calls[0]?.[1] as
      | { rest?: { retries?: number } }
      | undefined;
    expect(options?.rest?.retries).toBe(0);
  });

  it("throws without sending when the dev test webhook secret id is missing", async () => {
    process.env.NODE_ENV = "development";
    mockConfig.DISCORD_TEST_WEBHOOK_URL_SECRET_ID = undefined;
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toThrow(
      "DISCORD_TEST_WEBHOOK_URL_SECRET_ID env var is not set",
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
