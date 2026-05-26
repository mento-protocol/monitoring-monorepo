/**
 * Unit tests for Slack message formatting.
 */

import { describe, expect, it, vi } from "vitest";
import { formatSlackMessage } from "./slack";
import type { QuickNodeDecodedLog } from "./types";

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
