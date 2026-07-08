import { EmbedBuilder } from "@discordjs/builders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => {
  const mockConfig: {
    DISCORD_WEBHOOK_URL_SECRET_ID: string;
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: string | undefined;
  } = {
    DISCORD_WEBHOOK_URL_SECRET_ID: "discord-webhook-url",
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: "discord-test-webhook-url",
  };
  return { mockConfig };
});

const mockGetSecret = vi.fn();
vi.mock("../../utils/get-secret.js", () => ({ default: mockGetSecret }));

vi.mock("../../config.js", () => ({ default: mockConfig }));

function discordResponse(status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify({ ok: false }), {
    status,
  });
}

const embed = new EmbedBuilder().setTitle("Proposal created");

describe("sendDiscordNotification", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    mockConfig.DISCORD_WEBHOOK_URL_SECRET_ID = "discord-webhook-url";
    mockConfig.DISCORD_TEST_WEBHOOK_URL_SECRET_ID = "discord-test-webhook-url";
    mockGetSecret.mockResolvedValue("https://discord.com/api/webhooks/1/token");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    vi.unstubAllGlobals();
  });

  it("delivers exactly once when a 5xx failure is followed by success", async () => {
    fetchMock
      .mockResolvedValueOnce(discordResponse(503))
      .mockResolvedValueOnce(discordResponse(204));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal 4xx failure", async () => {
    fetchMock.mockResolvedValue(discordResponse(400));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toThrow(
      "Discord webhook returned 400",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a rate-limit response", async () => {
    fetchMock.mockResolvedValue(discordResponse(429));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toThrow(
      "Discord webhook returned 429",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("selects the production webhook secret by default", async () => {
    fetchMock.mockResolvedValue(discordResponse(204));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(mockGetSecret).toHaveBeenCalledWith("discord-webhook-url");
  });

  it("selects the test webhook secret in development", async () => {
    process.env.NODE_ENV = "development";
    fetchMock.mockResolvedValue(discordResponse(204));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    expect(mockGetSecret).toHaveBeenCalledWith("discord-test-webhook-url");
  });

  it("posts the serialized Discord embed payload with a bounded request timeout", async () => {
    fetchMock.mockResolvedValue(discordResponse(204));
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await sendDiscordNotification("content", embed);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe("https://discord.com/api/webhooks/1/token");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      content: "content",
      embeds: [{ title: "Proposal created" }],
    });
  });

  it("throws without sending when the dev test webhook secret id is missing", async () => {
    process.env.NODE_ENV = "development";
    mockConfig.DISCORD_TEST_WEBHOOK_URL_SECRET_ID = undefined;
    const { default: sendDiscordNotification } =
      await import("../send-discord-notification.js");

    await expect(sendDiscordNotification("content", embed)).rejects.toThrow(
      "DISCORD_TEST_WEBHOOK_URL_SECRET_ID env var is not set",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
