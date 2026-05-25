/**
 * Unit tests for Discord message formatting
 */

import { describe, expect, it, vi } from "vitest";
import { formatDiscordMessage } from "./discord";
import type { QuickNodeDecodedLog } from "./types";

// Mock the config module to avoid requiring environment variables
vi.mock("./config", () => ({
  default: {
    DISCORD_WEBHOOK_ALERTS: "https://discord.com/api/webhooks/test/alerts",
    DISCORD_WEBHOOK_EVENTS: "https://discord.com/api/webhooks/test/events",
    MULTISIG_CONFIG: JSON.stringify({
      "test-multisig": {
        address: "0x123",
        name: "Test Multisig",
        chain: "celo",
      },
    }),
    QUICKNODE_SIGNING_SECRET: "test-secret",
  },
}));

// Mock the utils module
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

describe("formatDiscordMessage", () => {
  it("should format a security event message", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "AddedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const message = await formatDiscordMessage(
      "AddedOwner",
      log,
      "test-multisig",
      new Map(),
    );

    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0].title).toContain("Test Multisig");
    expect(message.embeds[0].fields.length).toBeGreaterThan(0);
  });

  it("should include transaction hash field", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "ExecutionSuccess",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const message = await formatDiscordMessage(
      "ExecutionSuccess",
      log,
      "test-multisig",
      new Map(),
    );

    const txField = message.embeds[0].fields.find(
      (f) => f.name === "Transaction Hash",
    );
    expect(txField).toBeDefined();
    expect(txField?.value).toContain("0xtx1");
  });

  it("should include Safe UI link", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "ExecutionSuccess",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const message = await formatDiscordMessage(
      "ExecutionSuccess",
      log,
      "test-multisig",
      new Map(),
    );

    const safeUiField = message.embeds[0].fields.find(
      (f) => f.name === "Safe UI Link",
    );
    expect(safeUiField).toBeDefined();
    expect(safeUiField?.value).toContain("https://app.safe.global");
  });
});
