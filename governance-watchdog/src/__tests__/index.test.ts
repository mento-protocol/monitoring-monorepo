import type { Request, Response } from "@google-cloud/functions-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import healthCheck from "../events/fixtures/health-check.fixture.json";
import proposalCreated from "../events/fixtures/proposal-created.fixture.json";

const {
  mockCheckWebhookStatus,
  mockDiscordSend,
  mockFetch,
  mockGetSecret,
  mockHasAuthToken,
  mockIsFromQuicknode,
} = vi.hoisted(() => ({
  mockCheckWebhookStatus: vi.fn(),
  mockDiscordSend: vi.fn(),
  mockFetch: vi.fn(),
  mockGetSecret: vi.fn(),
  mockHasAuthToken: vi.fn(),
  mockIsFromQuicknode: vi.fn(),
}));

vi.mock("../config.js", () => ({
  default: {
    GCP_PROJECT_ID: "test-project",
    DISCORD_WEBHOOK_URL_SECRET_ID: "discord-webhook-url",
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: "discord-test-webhook-url",
    QUICKNODE_API_KEY_SECRET_ID: "quicknode-api-key",
    QUICKNODE_SECURITY_TOKEN_SECRET_ID: "quicknode-security-token",
    X_AUTH_TOKEN_SECRET_ID: "x-auth-token",
    TELEGRAM_BOT_TOKEN_SECRET_ID: "telegram-bot-token",
    TELEGRAM_CHAT_ID: "test-chat-id",
    TELEGRAM_TEST_CHAT_ID: "test-test-chat-id",
  },
}));

vi.mock("../utils/get-secret.js", () => ({ default: mockGetSecret }));

vi.mock("../utils/validate-request-origin.js", () => ({
  hasAuthToken: mockHasAuthToken,
  isFromQuicknode: mockIsFromQuicknode,
}));

vi.mock("../quicknode-health/index.js", () => ({
  checkWebhookStatus: mockCheckWebhookStatus,
}));

vi.mock("discord.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("discord.js")>()),
  WebhookClient: vi.fn(function WebhookClient() {
    return { send: mockDiscordSend };
  }),
}));

type MockResponse = Response & {
  send: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
};

function makeRes(): MockResponse {
  const res = {
    send: vi.fn(),
    status: vi.fn(),
  } as unknown as MockResponse;
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

function makeReq(path: string, body: unknown): Request {
  return {
    body,
    headers: {},
    path,
  } as unknown as Request;
}

async function loadFunction() {
  const { governanceWatchdog } = await import("../index.js");
  return governanceWatchdog;
}

function telegramPayload() {
  const [, init] = mockFetch.mock.calls[0] as [
    string,
    { body?: string } | undefined,
  ];
  if (!init?.body) throw new Error("Expected Telegram fetch body");
  return JSON.parse(init.body) as {
    chat_id: string;
    parse_mode: string;
    text: string;
  };
}

describe("governanceWatchdog HTTP entrypoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockGetSecret.mockResolvedValue("fake-secret");
    mockIsFromQuicknode.mockResolvedValue(true);
    mockHasAuthToken.mockResolvedValue(false);
    mockDiscordSend.mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });
  });

  it("delivers proposal notifications to Discord and Telegram", async () => {
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", proposalCreated), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDiscordSend).toHaveBeenCalledOnce();
    expect(mockDiscordSend.mock.calls[0][0]).toMatchObject({
      content: "MGP-0: Fund MiniPay airdrops & incentive campaigns",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botfake-secret/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(telegramPayload()).toMatchObject({
      chat_id: "test-chat-id",
      parse_mode: "HTML",
    });
    expect(telegramPayload().text).toContain(
      "<b>Proposal Link:</b> https://governance.mento.org/proposals/",
    );
  });

  it("deduplicates repeated events within one warm module instance", async () => {
    const governanceWatchdog = await loadFunction();

    await governanceWatchdog(makeReq("/", proposalCreated), makeRes());
    await governanceWatchdog(makeReq("/", proposalCreated), makeRes());

    expect(mockDiscordSend).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("handles health-check fixtures without sending notifications", async () => {
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", healthCheck), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDiscordSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated webhook requests", async () => {
    mockIsFromQuicknode.mockResolvedValue(false);
    mockHasAuthToken.mockResolvedValue(false);
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", proposalCreated), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockDiscordSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes requests authenticated via x-auth-token", async () => {
    mockIsFromQuicknode.mockResolvedValue(false);
    mockHasAuthToken.mockResolvedValue(true);
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", proposalCreated), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDiscordSend).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns 500 for QuickNode error bodies", async () => {
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", { error: "boom" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("returns 200 for an empty body", async () => {
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/", null), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("No events to process");
  });

  it("returns 200 when QuickNode webhooks are healthy", async () => {
    mockCheckWebhookStatus.mockResolvedValue({
      healthy: true,
      unhealthyWebhooks: [],
      webhooks: [{ name: "governor", status: "active" }],
    });
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/quicknode-health", null), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 500 when QuickNode webhooks are unhealthy", async () => {
    mockCheckWebhookStatus.mockResolvedValue({
      healthy: false,
      unhealthyWebhooks: ["governor"],
      webhooks: [{ name: "governor", status: "paused" }],
    });
    const governanceWatchdog = await loadFunction();
    const res = makeRes();

    await governanceWatchdog(makeReq("/quicknode-health", null), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Unhealthy webhooks: governor");
  });
});
