import { describe, it, expect } from "vitest";
import {
  resolveIsContractRow,
  resolveEffectiveLabel,
  validateLabelForm,
} from "@/components/address-label-editor";

// ---------------------------------------------------------------------------
// resolveIsContractRow
// ---------------------------------------------------------------------------

describe("resolveIsContractRow", () => {
  it("returns true for an existing address with initial data and no custom label", () => {
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
        initial: { label: "Reserve" },
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
        initial: { label: "Reserve" },
        isCustom: true,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveLabel
// ---------------------------------------------------------------------------

describe("resolveEffectiveLabel", () => {
  it("returns the typed label for a non-contract row", () => {
    expect(resolveEffectiveLabel("My Wallet", false, undefined)).toBe(
      "My Wallet",
    );
  });

  it("falls back to initialLabel when label is empty on a contract row", () => {
    expect(resolveEffectiveLabel("", true, "Reserve")).toBe("Reserve");
  });

  it("uses the typed label even on a contract row when provided", () => {
    expect(resolveEffectiveLabel("Custom Name", true, "Reserve")).toBe(
      "Custom Name",
    );
  });

  it("trims whitespace from the typed label", () => {
    expect(resolveEffectiveLabel("  Binance  ", false, undefined)).toBe(
      "Binance",
    );
  });

  it("returns empty string when contract row has no initial label and input is empty", () => {
    expect(resolveEffectiveLabel("", true, undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// validateLabelForm
// ---------------------------------------------------------------------------

const validAddress = "0x" + "a".repeat(40);

describe("validateLabelForm", () => {
  it("returns null for a valid new address with a label", () => {
    expect(
      validateLabelForm({
        isNewAddress: true,
        address: validAddress,
        label: "My Wallet",
        isContractRow: false,
      }),
    ).toBeNull();
  });

  it("returns an error for an invalid new address", () => {
    expect(
      validateLabelForm({
        isNewAddress: true,
        address: "not-an-address",
        label: "My Wallet",
        isContractRow: false,
      }),
    ).toMatch(/valid 0x/i);
  });

  it("returns an error when label is empty on a non-contract row", () => {
    expect(
      validateLabelForm({
        isNewAddress: false,
        address: validAddress,
        label: "",
        isContractRow: false,
      }),
    ).toMatch(/required/i);
  });

  it("returns null when label is empty on a contract row (optional)", () => {
    expect(
      validateLabelForm({
        isNewAddress: false,
        address: validAddress,
        label: "",
        isContractRow: true,
      }),
    ).toBeNull();
  });

  it("returns null for whitespace-only label on a contract row", () => {
    expect(
      validateLabelForm({
        isNewAddress: false,
        address: validAddress,
        label: "   ",
        isContractRow: true,
      }),
    ).toBeNull();
  });

  it("returns an error for whitespace-only label on a non-contract row", () => {
    expect(
      validateLabelForm({
        isNewAddress: false,
        address: validAddress,
        label: "   ",
        isContractRow: false,
      }),
    ).toMatch(/required/i);
  });
});
