import { describe, it, expect } from "vitest";
import {
  resolveIsContractRow,
  resolveEffectiveName,
  validateEntryForm,
} from "@/components/address-label-editor";

// resolveIsContractRow

describe("resolveIsContractRow", () => {
  it("returns true for an existing address with initial data and no custom label", () => {
    expect(
      resolveIsContractRow({
        isNewAddress: false,
        initial: { name: "Reserve" },
        isCustom: false,
      }),
    ).toBe(true);
  });

  it("returns true with legacy label field in initial data", () => {
    expect(
      resolveIsContractRow({
        isNewAddress: false,
        initial: { label: "Reserve" },
        isCustom: false,
      }),
    ).toBe(true);
  });

  it("returns false when isNewAddress is true", () => {
    expect(
      resolveIsContractRow({
        isNewAddress: true,
        initial: { name: "Reserve" },
        isCustom: false,
      }),
    ).toBe(false);
  });

  it("returns false when initial is undefined (no static contract data)", () => {
    expect(
      resolveIsContractRow({
        isNewAddress: false,
        initial: undefined,
        isCustom: false,
      }),
    ).toBe(false);
  });

  it("returns false when the address already has a custom label", () => {
    expect(
      resolveIsContractRow({
        isNewAddress: false,
        initial: { name: "Reserve" },
        isCustom: true,
      }),
    ).toBe(false);
  });
});

// resolveEffectiveName (and deprecated resolveEffectiveLabel alias)

describe("resolveEffectiveName", () => {
  it("returns the typed name for a non-contract row", () => {
    expect(resolveEffectiveName("My Wallet", false, undefined)).toBe(
      "My Wallet",
    );
  });

  it("falls back to initialName when name is empty on a contract row", () => {
    expect(resolveEffectiveName("", true, "Reserve")).toBe("Reserve");
  });

  it("uses the typed name even on a contract row when provided", () => {
    expect(resolveEffectiveName("Custom Name", true, "Reserve")).toBe(
      "Custom Name",
    );
  });

  it("trims whitespace from the typed name", () => {
    expect(resolveEffectiveName("  Binance  ", false, undefined)).toBe(
      "Binance",
    );
  });

  it("returns empty string when contract row has no initial name and input is empty", () => {
    expect(resolveEffectiveName("", true, undefined)).toBe("");
  });
});

// validateEntryForm (and deprecated validateLabelForm)

const validAddress = "0x" + "a".repeat(40);

describe("validateEntryForm", () => {
  it("returns null for a valid new address with a name", () => {
    expect(
      validateEntryForm({
        isNewAddress: true,
        address: validAddress,
        name: "My Wallet",
        isContractRow: false,
      }),
    ).toBeNull();
  });

  it("returns an error for an invalid new address", () => {
    expect(
      validateEntryForm({
        isNewAddress: true,
        address: "not-an-address",
        name: "My Wallet",
        isContractRow: false,
      }),
    ).toMatch(/valid 0x/i);
  });

  it("returns an error when name is empty and no tags on a non-contract row", () => {
    expect(
      validateEntryForm({
        isNewAddress: false,
        address: validAddress,
        name: "",
        isContractRow: false,
      }),
    ).toMatch(/required/i);
  });

  it("returns null when name is empty but tags present on a non-contract row", () => {
    expect(
      validateEntryForm({
        isNewAddress: false,
        address: validAddress,
        name: "",
        tags: ["Market Maker"],
        isContractRow: false,
      }),
    ).toBeNull();
  });

  it("returns null when name is empty on a contract row (optional)", () => {
    expect(
      validateEntryForm({
        isNewAddress: false,
        address: validAddress,
        name: "",
        isContractRow: true,
      }),
    ).toBeNull();
  });

  it("returns null for whitespace-only name on a contract row", () => {
    expect(
      validateEntryForm({
        isNewAddress: false,
        address: validAddress,
        name: "   ",
        isContractRow: true,
      }),
    ).toBeNull();
  });

  it("returns an error for whitespace-only name with no tags on a non-contract row", () => {
    expect(
      validateEntryForm({
        isNewAddress: false,
        address: validAddress,
        name: "   ",
        isContractRow: false,
      }),
    ).toMatch(/required/i);
  });
});
