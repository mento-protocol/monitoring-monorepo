import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: {
      data?: Array<{ labels?: string[]; values?: number[] }>;
    }) {
      return React.createElement(
        "div",
        null,
        "plot",
        ...(props.data?.[0]?.labels?.map((label) =>
          React.createElement("span", { key: label }, label),
        ) ?? []),
        ...(props.data?.[0]?.values?.map((value) =>
          React.createElement(
            "span",
            { key: `value-${String(value)}` },
            String(value),
          ),
        ) ?? []),
      );
    },
}));

import {
  LpConcentrationChart,
  resolvePieLabel,
} from "@/components/lp-concentration-chart";
import { truncateAddress } from "@/lib/format";
import type { Pool } from "@/lib/types";

const ADDR = "0x10158838fa2ded977b8bf175ea69d17a715371c0";
const ADDR2 = "0xd363dab93e4ded977b8bf175ea69d17a715371c1";

const BASE_POOL: Pool = {
  id: "0xpool",
  token0: "0xgbp",
  token1: "0xusd",
  source: "fpmm_factory",
  chainId: 42220,
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  token0Decimals: 18,
  token1Decimals: 18,
  oraclePrice: "1190000000000000000000000",
  reserves0: "100000000000000000000",
  reserves1: "119000000000000000000",
};

describe("resolvePieLabel", () => {
  it("returns truncated address when no getLabel provided", () => {
    expect(resolvePieLabel(ADDR)).toBe(truncateAddress(ADDR));
  });

  it("returns named label when getLabel resolves a real name", () => {
    const getLabel = () => "Team Wallet";
    expect(resolvePieLabel(ADDR, getLabel)).toBe("Team Wallet");
  });

  it("returns truncated address when getLabel returns the truncated form", () => {
    const getLabel = (address: string) => truncateAddress(address) ?? address;
    expect(resolvePieLabel(ADDR, getLabel)).toBe(truncateAddress(ADDR));
  });

  it("does not include raw address when a named label exists", () => {
    const getLabel = () => "Team Wallet";
    const result = resolvePieLabel(ADDR, getLabel);
    expect(result).not.toContain("0x1015");
    expect(result).toBe("Team Wallet");
  });

  it("does not duplicate unlabelled addresses", () => {
    const getLabel = (address: string) => truncateAddress(address) ?? address;
    const result = resolvePieLabel(ADDR, getLabel);
    expect(result).not.toBe(ADDR);
    expect(result).toBe(truncateAddress(ADDR));
  });

  it("allows multiple addresses to resolve to the same human label", () => {
    const getLabel = () => "Shared Label";
    expect(resolvePieLabel(ADDR, getLabel)).toBe("Shared Label");
    expect(resolvePieLabel(ADDR2, getLabel)).toBe("Shared Label");
  });
});

describe("LpConcentrationChart", () => {
  const positions = [
    { address: ADDR, netLiquidity: BigInt(70) },
    { address: ADDR2, netLiquidity: BigInt(30) },
  ];

  it("renders human labels in the visible legend when available", () => {
    const html = renderToStaticMarkup(
      React.createElement(LpConcentrationChart, {
        positions,
        totalLiquidity: BigInt(100),
        getLabel: (address: string | null) =>
          address === ADDR
            ? "Treasury"
            : (truncateAddress(address ?? "") ?? ""),
      }),
    );

    expect(html).toContain("Legend");
    expect(html).toContain("Treasury");
    const legendHtml = html.split("Legend")[1] ?? "";
    expect(legendHtml).not.toContain(ADDR);
  });

  it("renders sidebar stats and estimated TVL for USDm pairs", () => {
    const html = renderToStaticMarkup(
      React.createElement(LpConcentrationChart, {
        positions,
        totalLiquidity: BigInt(100),
        pool: BASE_POOL,
        sym0: "GBPm",
        sym1: "USDm",
        reserves0Raw: 100,
        reserves1Raw: 119,
        feedVal: 1.19,
        usdmIsToken0: false,
      }),
    );

    expect(html).toContain("Pool at a glance");
    expect(html).toContain("Top holder");
    expect(html).toContain("Top 3 share");
    expect(html).toContain("Estimated TVL");
  });

  it("hides estimated TVL when no valid USDm side exists", () => {
    const html = renderToStaticMarkup(
      React.createElement(LpConcentrationChart, {
        positions,
        totalLiquidity: BigInt(100),
        pool: { ...BASE_POOL, token1: "0xeur" },
        sym0: "GBPm",
        sym1: "EURm",
        reserves0Raw: 100,
        reserves1Raw: 90,
        feedVal: 1.19,
        usdmIsToken0: false,
      }),
    );

    expect(html).not.toContain("Estimated TVL");
  });
});
