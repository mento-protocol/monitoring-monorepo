import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Network } from "@/lib/networks";
import { ChainIcon } from "@/components/chain-icon";

const BASE: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "",
  hasuraSecret: "",
  explorerBaseUrl: "",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

describe("ChainIcon", () => {
  it("renders the branded Celo icon for chainId 42220", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).toContain('aria-label="Celo"');
    expect(html).toContain('class="web3icons"');
    expect(html).toContain('fill="#FCFE52"');
  });

  it("renders the same branded Celo icon for Celo Sepolia (11142220)", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{
          ...BASE,
          id: "celo-sepolia-local",
          chainId: 11142220,
          label: "Celo Sepolia",
          local: true,
          testnet: true,
        }}
      />,
    );
    expect(html).toContain('aria-label="Celo Sepolia"');
    expect(html).toContain('fill="#FCFE52"');
  });

  it("renders the branded Monad icon for chainId 143", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{ ...BASE, id: "monad-mainnet", chainId: 143, label: "Monad" }}
      />,
    );
    expect(html).toContain('aria-label="Monad"');
    expect(html).toContain('fill="#836EF9"');
  });

  it("renders the branded Polygon icon for chainId 137", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{
          ...BASE,
          id: "celo-mainnet",
          chainId: 137,
          label: "Polygon",
        }}
      />,
    );
    expect(html).toContain('aria-label="Polygon"');
    expect(html).toContain('class="web3icons"');
  });

  it("falls back to a generic slate circle for an unknown chainId", () => {
    const html = renderToStaticMarkup(
      <ChainIcon network={{ ...BASE, chainId: 99999, label: "Some Chain" }} />,
    );
    expect(html).toContain('aria-label="Some Chain"');
    expect(html).toContain('fill="#64748b"');
    expect(html).not.toContain('class="web3icons"');
  });

  it("dims the icon (opacity-60) when network.testnet is true", () => {
    const html = renderToStaticMarkup(
      <ChainIcon network={{ ...BASE, testnet: true, label: "Testy" }} />,
    );
    expect(html).toContain("opacity-60");
  });

  it("dims the icon (opacity-60) when network.local is true (same-chainId as mainnet)", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{
          ...BASE,
          id: "celo-mainnet-local",
          label: "Celo (local)",
          local: true,
        }}
      />,
    );
    expect(html).toContain("opacity-60");
  });

  it("does not dim the icon for mainnet networks", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).not.toContain("opacity-60");
  });

  it("exposes network.label via accessible wrapper markup", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Celo"');
    expect(html).toContain('title="Celo"');
  });
});
