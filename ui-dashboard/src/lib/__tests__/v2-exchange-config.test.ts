import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";

const mockGetCode = vi.fn();
const mockReadContract = vi.fn();

vi.mock("../rpc-client", () => ({
  getViemClient: () => ({
    getCode: mockGetCode,
    readContract: mockReadContract,
  }),
}));

import {
  resolveV2ExchangeConfig,
  serializeV2ExchangeConfig,
  type V2ExchangeConfig,
} from "../v2-exchange-config";

const RPC_URL = "https://forno.celo.org";
const POOL = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 42220;

// Mainnet BiPoolManager + a known exchangeId, padded to 32 bytes each as the
// VirtualPool bytecode emits them. The opcode separator
// `81 16 6004 83 01 52 7f` corresponds to the swap() preamble that pushes
// `(exchangeProvider, exchangeId)` onto the stack.
const MGR_ADDR = "22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const MGR_PADDED = "000000000000000000000000" + MGR_ADDR; // 64 hex chars
const EXCHANGE_ID =
  "3f0e8d2a4c1b6e7f9d8c5a3b2e1f4d6c8b7a9e0d3c2f1e4a6b5d8c9e0f2a3b4c";

const VP_BYTECODE_PATTERN = (mgr: string, exId: string) =>
  "0x6080604052..." + // realistic preamble noise
  "7f" +
  mgr +
  "811660048301527f" +
  exId +
  "...60806040"; // tail noise

// Active-exchange struct (non-zero pricingModule + nonzero buckets).
const ACTIVE_STRUCT = {
  asset0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
  asset1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
  pricingModule: "0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb" as const,
  bucket0: BigInt("1000000000000000000000000"),
  bucket1: BigInt("950000000000000000000000"),
  lastBucketUpdate: BigInt(1716120000),
  config: {
    spread: { value: BigInt("5000000000000000000000") }, // 50 bps
    referenceRateFeedID: "0xcccccccccccccccccccccccccccccccccccccccc" as const,
    referenceRateResetFrequency: BigInt(360),
    minimumReports: BigInt(1),
    stablePoolResetSize: BigInt("100000000000000000000000"),
  },
};

// All-zero struct returned by older BiPoolManager versions for removed
// exchanges (instead of reverting).
const ZERO_STRUCT = {
  asset0: "0x0000000000000000000000000000000000000000" as const,
  asset1: "0x0000000000000000000000000000000000000000" as const,
  pricingModule: "0x0000000000000000000000000000000000000000" as const,
  bucket0: BigInt(0),
  bucket1: BigInt(0),
  lastBucketUpdate: BigInt(0),
  config: {
    spread: { value: BigInt(0) },
    referenceRateFeedID: "0x0000000000000000000000000000000000000000" as const,
    referenceRateResetFrequency: BigInt(0),
    minimumReports: BigInt(0),
    stablePoolResetSize: BigInt(0),
  },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveV2ExchangeConfig", () => {
  it("returns no_bytecode when getCode is empty", async () => {
    mockGetCode.mockResolvedValueOnce("0x");

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result).toEqual({ ok: false, reason: "no_bytecode" });
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns no_bytecode when getCode returns undefined", async () => {
    mockGetCode.mockResolvedValueOnce(undefined);

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result).toEqual({ ok: false, reason: "no_bytecode" });
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns not_a_virtual_pool when bytecode lacks the PUSH32 sequence", async () => {
    // Realistic non-VP runtime bytecode that doesn't include the
    // (PUSH32 mgr, DUP2, AND, PUSH1 0x04, DUP4, ADD, MSTORE, PUSH32 exId)
    // separator sequence.
    mockGetCode.mockResolvedValueOnce("0x6080604052348015600f57600080fd");

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result).toEqual({ ok: false, reason: "not_a_virtual_pool" });
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("extracts exchangeProvider + exchangeId from valid VP bytecode and returns active config", async () => {
    mockGetCode.mockResolvedValueOnce(
      VP_BYTECODE_PATTERN(MGR_PADDED, EXCHANGE_ID),
    );
    mockReadContract.mockResolvedValueOnce(ACTIVE_STRUCT);

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrowing
    expect(result.config.exchangeProvider).toBe("0x" + MGR_ADDR);
    expect(result.config.exchangeId).toBe("0x" + EXCHANGE_ID);
    expect(result.config.isDeprecated).toBe(false);
    expect(result.config.pricingModuleName).toBe("ConstantSum");
    expect(result.config.spread).toBe(BigInt("5000000000000000000000"));
    expect(result.config.bucket0).toBe(BigInt("1000000000000000000000000"));

    // Verify it called readContract with the extracted values
    const call = mockReadContract.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      address: "0x" + MGR_ADDR,
      functionName: "getPoolExchange",
      args: ["0x" + EXCHANGE_ID],
    });
  });

  it("returns deprecated config when BiPoolManager reverts with 'does not exist'", async () => {
    mockGetCode.mockResolvedValueOnce(
      VP_BYTECODE_PATTERN(MGR_PADDED, EXCHANGE_ID),
    );

    // Build a viem-shaped error chain that walks to a
    // ContractFunctionRevertedError with reason containing "does not exist".
    const reverted = Object.create(ContractFunctionRevertedError.prototype);
    Object.assign(reverted, {
      reason: "An exchange with the specified id does not exist",
      message: "exchange does not exist",
    });
    const wrapper = Object.create(BaseError.prototype);
    Object.assign(wrapper, {
      message: "execution reverted",
      walk: (predicate: (e: unknown) => boolean) =>
        predicate(reverted) ? reverted : undefined,
    });
    mockReadContract.mockRejectedValueOnce(wrapper);

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.isDeprecated).toBe(true);
    expect(result.config.exchangeProvider).toBe("0x" + MGR_ADDR);
    expect(result.config.exchangeId).toBe("0x" + EXCHANGE_ID);
    expect(result.config.bucket0).toBe(BigInt(0));
    expect(result.config.bucket1).toBe(BigInt(0));
    expect(result.config.pricingModule).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("returns rpc_failed on generic upstream errors (NOT classified as deprecated)", async () => {
    mockGetCode.mockResolvedValueOnce(
      VP_BYTECODE_PATTERN(MGR_PADDED, EXCHANGE_ID),
    );
    mockReadContract.mockRejectedValueOnce(new Error("connection reset"));

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result).toEqual({ ok: false, reason: "rpc_failed" });
  });

  it("classifies all-zero struct (older BiPoolManager) as deprecated", async () => {
    mockGetCode.mockResolvedValueOnce(
      VP_BYTECODE_PATTERN(MGR_PADDED, EXCHANGE_ID),
    );
    mockReadContract.mockResolvedValueOnce(ZERO_STRUCT);

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.isDeprecated).toBe(true);
    expect(result.config.bucket0).toBe(BigInt(0));
  });

  it("returns null pricingModuleName for unknown pricing modules", async () => {
    mockGetCode.mockResolvedValueOnce(
      VP_BYTECODE_PATTERN(MGR_PADDED, EXCHANGE_ID),
    );
    mockReadContract.mockResolvedValueOnce({
      ...ACTIVE_STRUCT,
      pricingModule: "0x9999999999999999999999999999999999999999",
    });

    const result = await resolveV2ExchangeConfig(POOL, RPC_URL, CHAIN_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.pricingModuleName).toBeNull();
  });
});

describe("serializeV2ExchangeConfig", () => {
  it("converts every BigInt field to a decimal string and preserves non-numeric fields", () => {
    const input: V2ExchangeConfig = {
      exchangeId: ("0x" + EXCHANGE_ID) as `0x${string}`,
      exchangeProvider: ("0x" + MGR_ADDR) as `0x${string}`,
      asset0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
      asset1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
      pricingModule:
        "0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb" as `0x${string}`,
      pricingModuleName: "ConstantSum",
      spread: BigInt("5000000000000000000000"),
      referenceRateFeedID:
        "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`,
      referenceRateResetFrequency: BigInt(360),
      minimumReports: BigInt(1),
      stablePoolResetSize: BigInt("100000000000000000000000"),
      bucket0: BigInt("1000000000000000000000000"),
      bucket1: BigInt("950000000000000000000000"),
      lastBucketUpdate: BigInt(1716120000),
      isDeprecated: false,
    };

    const dto = serializeV2ExchangeConfig(input);

    expect(dto.spread).toBe("5000000000000000000000");
    expect(dto.bucket0).toBe("1000000000000000000000000");
    expect(dto.bucket1).toBe("950000000000000000000000");
    expect(dto.lastBucketUpdate).toBe("1716120000");
    expect(dto.referenceRateResetFrequency).toBe("360");
    expect(dto.minimumReports).toBe("1");
    expect(dto.stablePoolResetSize).toBe("100000000000000000000000");
    expect(dto.isDeprecated).toBe(false);
    expect(dto.pricingModuleName).toBe("ConstantSum");
    // Non-BigInt fields pass through verbatim.
    expect(dto.exchangeId).toBe("0x" + EXCHANGE_ID);
    expect(dto.exchangeProvider).toBe("0x" + MGR_ADDR);
  });

  it("round-trips JSON.stringify safely (no BigInt leakage)", () => {
    const input: V2ExchangeConfig = {
      exchangeId: ("0x" + EXCHANGE_ID) as `0x${string}`,
      exchangeProvider: ("0x" + MGR_ADDR) as `0x${string}`,
      asset0: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      asset1: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      pricingModule:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      pricingModuleName: null,
      spread: BigInt(0),
      referenceRateFeedID:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      referenceRateResetFrequency: BigInt(0),
      minimumReports: BigInt(0),
      stablePoolResetSize: BigInt(0),
      bucket0: BigInt(0),
      bucket1: BigInt(0),
      lastBucketUpdate: BigInt(0),
      isDeprecated: true,
    };

    expect(() =>
      JSON.stringify(serializeV2ExchangeConfig(input)),
    ).not.toThrow();
  });
});
