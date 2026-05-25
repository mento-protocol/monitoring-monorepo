/**
 * Unit tests for utils.ts
 *
 * Covers:
 * 1. findChainForAddress - chain detection from MULTISIGS_BY_CHAIN env config
 * 2. findChainFromBlockHash - chain detection via viem getBlock probing
 * 3. decodeEventData - SafeMultiSigTransaction special-case dispatch
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

// Mock config BEFORE importing utils so constants.ts builds
// MULTISIGS_BY_CHAIN from this fixture. Three multisigs:
// - SOLO_CELO: 0xaaa... only on celo
// - SOLO_ETH:  0xbbb... only on ethereum
// - AMBIGUOUS: 0xccc... on both celo + ethereum
vi.mock("./config", () => ({
  default: {
    DISCORD_WEBHOOK_ALERTS: "https://discord.com/api/webhooks/test/alerts",
    DISCORD_WEBHOOK_EVENTS: "https://discord.com/api/webhooks/test/events",
    MULTISIG_CONFIG: JSON.stringify({
      SOLO_CELO: {
        address: "0xAAaaaAAaAaAaAaaAaaAaaaaAaaAAaAAaAAaAaaAA",
        name: "Solo Celo",
        chain: "celo",
      },
      SOLO_ETH: {
        address: "0xBBbbbBBbBbBbBbbBbBBbbbbBbbbBbBBbBBbBbbBB",
        name: "Solo Ethereum",
        chain: "ethereum",
      },
      AMBIGUOUS_CELO: {
        address: "0xCCcccCCcCcCcCccCcCCcccCccccCcCCcCCcCccCC",
        name: "Ambiguous (Celo side)",
        chain: "celo",
      },
      AMBIGUOUS_ETH: {
        address: "0xCCcccCCcCcCcCccCcCCcccCccccCcCCcCCcCccCC",
        name: "Ambiguous (Eth side)",
        chain: "ethereum",
      },
    }),
    QUICKNODE_SIGNING_SECRET: "test-secret",
  },
}));

// Mock viem so we can drive getBlock per-test.
const getBlockMock = vi.fn();
const createPublicClientMock = vi.fn(() => ({
  getBlock: getBlockMock,
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: createPublicClientMock,
    http: vi.fn(() => "http-transport"),
  };
});

// Mock the SafeMultiSigTransaction formatter so decodeEventData's
// dynamic import resolves to a sentinel we can detect.
vi.mock("./event-formatters/transaction-formatters", () => ({
  formatSafeMultiSigTransactionEvent: vi.fn(async () => [
    {
      name: "_test_sentinel",
      value: "safe-multisig-formatter-called",
      inline: false,
    },
  ]),
  formatSafeReceivedEvent: vi.fn(async () => []),
}));

const SOLO_CELO_ADDR = "0xAAaaaAAaAaAaAaaAaaAaaaaAaaAAaAAaAAaAaaAA";
const SOLO_ETH_ADDR = "0xBBbbbBBbBbBbBbbBbBBbbbbBbbbBbBBbBBbBbbBB";
const AMBIGUOUS_ADDR = "0xCCcccCCcCcCcCccCcCCcccCccccCcCCcCCcCccCC";
const UNKNOWN_ADDR = "0xDDdddDDdDdDdDddDdDDdddDdddDdDdDDdDDdDDdd";
const BLOCK_HASH =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

describe("findChainForAddress", () => {
  let utils: typeof import("./utils");

  beforeEach(async () => {
    utils = await import("./utils");
  });

  it("returns the chain name when address is configured on exactly one chain", () => {
    expect(utils.findChainForAddress(SOLO_CELO_ADDR)).toBe("celo");
    expect(utils.findChainForAddress(SOLO_ETH_ADDR)).toBe("ethereum");
  });

  it("returns null when address is configured on multiple chains (ambiguity)", () => {
    expect(utils.findChainForAddress(AMBIGUOUS_ADDR)).toBeNull();
  });

  it("returns null when address is configured on zero chains (unknown)", () => {
    expect(utils.findChainForAddress(UNKNOWN_ADDR)).toBeNull();
  });

  it("is case-insensitive on address input", () => {
    expect(utils.findChainForAddress(SOLO_CELO_ADDR.toLowerCase())).toBe(
      "celo",
    );
    expect(utils.findChainForAddress(SOLO_CELO_ADDR.toUpperCase())).toBe(
      "celo",
    );
    // Mixed-case lookups should match too.
    expect(utils.findChainForAddress(SOLO_ETH_ADDR)).toBe("ethereum");
  });
});

describe("findChainFromBlockHash", () => {
  let utils: typeof import("./utils");

  beforeEach(async () => {
    utils = await import("./utils");
    getBlockMock.mockReset();
    createPublicClientMock.mockClear();
  });

  it("returns the unique chain immediately (no RPC calls) when address is on one chain", async () => {
    const result = await utils.findChainFromBlockHash(
      BLOCK_HASH,
      SOLO_CELO_ADDR,
    );
    expect(result).toBe("celo");
    expect(createPublicClientMock).not.toHaveBeenCalled();
    expect(getBlockMock).not.toHaveBeenCalled();
  });

  it("returns the chain where the block hash verifies (celo succeeds, ethereum fails)", async () => {
    // Drive both probes: celo returns a block; ethereum throws (block not found).
    getBlockMock.mockImplementation(async () => {
      // createPublicClient is called per-chain; we don't get chain context here,
      // so use call order: first call is celo (knownChains order), second is ethereum.
      // To be robust we use mockImplementationOnce so call order is explicit.
      throw new Error("default reject");
    });
    getBlockMock.mockReset();
    // First probed chain in knownChains = ["celo", "ethereum"] order → celo succeeds
    getBlockMock.mockResolvedValueOnce({ number: 12345n });
    // Second probed chain → ethereum rejects
    getBlockMock.mockRejectedValueOnce(new Error("block not found"));

    const result = await utils.findChainFromBlockHash(
      BLOCK_HASH,
      AMBIGUOUS_ADDR,
    );
    expect(result).toBe("celo");
    // Both candidate chains should have been probed in parallel
    expect(getBlockMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when block-hash verification fails on ALL candidate chains (fail-closed)", async () => {
    getBlockMock.mockRejectedValue(new Error("block not found"));

    const result = await utils.findChainFromBlockHash(
      BLOCK_HASH,
      AMBIGUOUS_ADDR,
    );
    expect(result).toBeNull();
    expect(getBlockMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when the address isn't configured on any chain", async () => {
    const result = await utils.findChainFromBlockHash(BLOCK_HASH, UNKNOWN_ADDR);
    expect(result).toBeNull();
    // No RPC calls should be attempted for unknown addresses
    expect(createPublicClientMock).not.toHaveBeenCalled();
    expect(getBlockMock).not.toHaveBeenCalled();
  });
});

describe("decodeEventData - SafeMultiSigTransaction dispatch", () => {
  let utils: typeof import("./utils");

  beforeEach(async () => {
    utils = await import("./utils");
  });

  it("SafeMultiSigTransaction dispatches to formatSafeMultiSigTransactionEvent (not the registry fallback)", async () => {
    const log = {
      address: "0x123",
      name: "SafeMultiSigTransaction",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const fields = await utils.decodeEventData(
      "SafeMultiSigTransaction",
      log,
      "0xsafeTx1",
      "celo",
    );

    // The mocked formatter returns a single sentinel field; non-empty proves
    // the special-case branch executed instead of the registry-fallback `[]`.
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0]).toEqual({
      name: "_test_sentinel",
      value: "safe-multisig-formatter-called",
      inline: false,
    });
  });

  it("Unknown event name falls through to the registry fallback (returns [])", async () => {
    const log = {
      address: "0x123",
      name: "UnknownEventName",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const fields = await utils.decodeEventData(
      "UnknownEventName",
      log,
      "0xsafeTx1",
      "celo",
    );

    expect(fields).toEqual([]);
  });
});

describe("extractSignersFromSignatures", () => {
  let utils: typeof import("./utils");
  const safeTxHash =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  const contractSigner = "0x1234567890abcdef1234567890abcdef12345678";
  const approvedHashSigner = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

  beforeEach(async () => {
    utils = await import("./utils");
  });

  function paddedAddress(address: string): string {
    return `${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  }

  function uint256Word(value: bigint): string {
    return value.toString(16).padStart(64, "0");
  }

  it("extracts v=0 contract signature owners from r even when s is a nonzero dynamic-data offset", async () => {
    const signature =
      paddedAddress(contractSigner) + uint256Word(65n) + "00" + "ff".repeat(65);

    await expect(
      utils.extractSignersFromSignatures(`0x${signature}`, safeTxHash),
    ).resolves.toEqual([contractSigner]);
  });

  it("does not parse contract-signature dynamic payload bytes as additional static signatures", async () => {
    const dynamicPayloadThatLooksLikeASignature =
      paddedAddress(approvedHashSigner) + uint256Word(0n) + "01";
    const signature =
      paddedAddress(contractSigner) +
      uint256Word(65n) +
      "00" +
      dynamicPayloadThatLooksLikeASignature;

    await expect(
      utils.extractSignersFromSignatures(`0x${signature}`, safeTxHash),
    ).resolves.toEqual([contractSigner]);
  });

  it("ignores oversized contract-signature dynamic offsets without precision loss", async () => {
    const hugeOffset = (1n << 240n) + 65n;
    const dynamicPayloadThatLooksLikeASignature =
      paddedAddress(approvedHashSigner) + uint256Word(0n) + "01";
    const signature =
      paddedAddress(contractSigner) +
      uint256Word(hugeOffset) +
      "00" +
      dynamicPayloadThatLooksLikeASignature;

    await expect(
      utils.extractSignersFromSignatures(`0x${signature}`, safeTxHash),
    ).resolves.toEqual([contractSigner, approvedHashSigner]);
  });

  it("extracts v=1 approved-hash signature owners from r", async () => {
    const signature =
      paddedAddress(approvedHashSigner) + uint256Word(0n) + "01";

    await expect(
      utils.extractSignersFromSignatures(`0x${signature}`, safeTxHash),
    ).resolves.toEqual([approvedHashSigner]);
  });

  it("recovers Safe eth_sign signatures encoded with v greater than 30", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const signature = await account.signMessage({
      message: { raw: safeTxHash },
    });
    const safeEthSignV = (Number.parseInt(signature.slice(-2), 16) + 4)
      .toString(16)
      .padStart(2, "0");
    const safeSignature = `${signature.slice(2, -2)}${safeEthSignV}`;

    await expect(
      utils.extractSignersFromSignatures(`0x${safeSignature}`, safeTxHash),
    ).resolves.toEqual([account.address.toLowerCase()]);
  });
});
