/**
 * Unit tests for Slack message formatting.
 */

import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSlackMessage, sendToSlack } from "./slack";
import type { QuickNodeDecodedLog } from "./types";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./config", () => ({
  default: {
    MULTISIG_CONFIG: JSON.stringify({
      "test-multisig": {
        address: "0x123",
        name: "Test Multisig",
        chain: "celo",
      },
    }),
    QUICKNODE_SIGNING_SECRET: "test-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_ALERTS: "Calerts",
    SLACK_CHANNEL_EVENTS: "Cevents",
  },
}));

vi.mock("./utils", async () => {
  const actual = await vi.importActual<typeof import("./utils")>("./utils");
  return {
    ...actual,
    getMultisigName: vi.fn((_key: string) => "Test Multisig"),
    getMultisigChainInfo: vi.fn((_key: string) => ({ chain: "celo" })),
    getSafeUiUrl: vi.fn(
      (_address: string, txHash: string, _key: string) =>
        `https://app.safe.global/transactions/tx?safe=celo:0x123&id=multisig_0x123_${txHash}`,
    ),
    getBlockExplorer: vi.fn(() => ({
      tx: (hash: string) => `https://celoscan.io/tx/${hash}`,
      address: (addr: string) => `https://celoscan.io/address/${addr}`,
    })),
    isSecurityEvent: vi.fn((eventName: string) =>
      ["AddedOwner", "RemovedOwner"].includes(eventName),
    ),
    decodeEventData: vi.fn(async () => []),
  };
});

describe("formatSlackMessage", () => {
  it("formats transaction and Safe links as Slack mrkdwn links", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "AddedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const message = await formatSlackMessage(
      "AddedOwner",
      log,
      "test-multisig",
      new Map(),
    );

    expect(message.text).toContain("Test Multisig");
    expect(JSON.stringify(message.blocks)).toContain(
      "<https://celoscan.io/tx/0xtx1|0xtx1>",
    );
    expect(JSON.stringify(message.blocks)).toContain(
      "<https://app.safe.global/transactions/tx?safe=celo:0x123&id=multisig_0x123_0xtx1|Open TX in Safe UI>",
    );
  });
});

describe("sendToSlack", () => {
  const postMock = vi.mocked(axios.post);
  const message = {
    text: "Test Multisig: AddedOwner",
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: "*Test Multisig*",
        },
      },
    ],
  };

  beforeEach(() => {
    vi.useRealTimers();
    postMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts Slack messages with token, channel, and unfurling disabled", async () => {
    postMock.mockResolvedValue({
      data: { ok: true },
      status: 200,
      statusText: "OK",
    });

    await sendToSlack("xoxb-test", "Calerts", message);

    expect(postMock).toHaveBeenCalledOnce();
    expect(postMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      {
        channel: "Calerts",
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
        }),
      }),
    );
  });

  it("does not retry non-retryable Slack API errors", async () => {
    postMock.mockResolvedValue({
      data: { ok: false, error: "invalid_auth" },
      status: 200,
      statusText: "OK",
    });

    await expect(sendToSlack("xoxb-test", "Calerts", message)).rejects.toThrow(
      "invalid_auth",
    );

    expect(postMock).toHaveBeenCalledOnce();
  });

  it("respects Slack Retry-After on rate-limited responses", async () => {
    vi.useFakeTimers();
    const rateLimitError = Object.assign(new Error("Too Many Requests"), {
      response: {
        data: { error: "ratelimited" },
        headers: { "retry-after": "3" },
        status: 429,
        statusText: "Too Many Requests",
      },
    });

    postMock.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
      data: { ok: true },
      status: 200,
      statusText: "OK",
    });

    const result = sendToSlack("xoxb-test", "Calerts", message);
    await vi.advanceTimersByTimeAsync(2999);
    expect(postMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(postMock).toHaveBeenCalledTimes(2);
  });
});
