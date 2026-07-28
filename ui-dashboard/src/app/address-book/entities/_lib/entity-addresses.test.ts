import { describe, expect, it } from "vitest";
import { parseEntityAddresses } from "./entity-addresses";

describe("parseEntityAddresses", () => {
  it("accepts string and object shapes, de-duplicates, sorts, and marks EVM addresses", () => {
    const evmAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(
      parseEntityAddresses([
        { address: evmAddress, chain: "ethereum" },
        { address: evmAddress.toUpperCase(), chain: "ETHEREUM" },
        { address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE", chainName: "tron" },
        { address: "" },
        null,
      ]),
    ).toEqual([
      {
        address: evmAddress,
        chain: "ethereum",
        canOpenInAddressBook: true,
      },
      {
        address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
        chain: "tron",
        canOpenInAddressBook: false,
      },
    ]);
  });

  it("preserves one address on each known chain and drops its chainless duplicate", () => {
    const address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(
      parseEntityAddresses([
        address,
        { address, chain: "celo" },
        { address, chain: "ethereum" },
      ]),
    ).toEqual([
      { address, chain: "celo", canOpenInAddressBook: true },
      { address, chain: "ethereum", canOpenInAddressBook: true },
    ]);
  });

  it("returns an empty list for missing or malformed payloads", () => {
    expect(parseEntityAddresses(null)).toEqual([]);
    expect(parseEntityAddresses({ address: "0x123" })).toEqual([]);
    expect(parseEntityAddresses([{}, 123, false])).toEqual([]);
  });
});
