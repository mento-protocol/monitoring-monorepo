import { describe, expect, it } from "vitest";
import {
  formatBpsPercent,
  formatInterestRate,
  icrTextClass,
  troveManageUrl,
} from "../format";

describe("formatBpsPercent", () => {
  it("renders a bps value as a percent", () => {
    expect(formatBpsPercent(11_710)).toBe("117.10%");
  });

  it("renders the unknown sentinel as an em dash", () => {
    expect(formatBpsPercent(-1)).toBe("—");
  });
});

describe("formatInterestRate", () => {
  const D18 = BigInt(10) ** BigInt(18);

  it("renders a wei-scaled annual rate as a percent", () => {
    expect(
      formatInterestRate(((BigInt(250) * D18) / BigInt(10_000)).toString()),
    ).toBe("2.50%");
  });

  it("renders zero and null distinctly", () => {
    expect(formatInterestRate("0")).toBe("0.00%");
    expect(formatInterestRate(null)).toBe("—");
  });
});

describe("icrTextClass", () => {
  it("colors below MCR as danger, near MCR as warning, healthy as safe", () => {
    expect(icrTextClass(10_500, 11_000)).toBe("text-rose-300");
    expect(icrTextClass(11_500, 11_000)).toBe("text-amber-300");
    expect(icrTextClass(20_000, 11_000)).toBe("text-emerald-300");
  });

  it("renders the unknown sentinel as muted", () => {
    expect(icrTextClass(-1, 11_000)).toBe("text-slate-500");
  });
});

describe("troveManageUrl", () => {
  it("builds the Mento app manage link without a hash prefix", () => {
    expect(troveManageUrl("0x8abc", "GBPm")).toBe(
      "https://app.mento.org/borrow/manage/0x8abc?token=GBPm",
    );
  });
});
