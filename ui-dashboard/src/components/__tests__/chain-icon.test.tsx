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
  it("renders Celo yellow for chainId 42220", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).toContain('fill="#FCFF52"');
    expect(html).toContain("<title>Celo</title>");
  });

  it("renders Celo yellow for Celo Sepolia chainId 11142220", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{
          ...BASE,
          id: "celo-sepolia",
          chainId: 11142220,
          label: "Celo Sepolia",
          testnet: true,
        }}
      />,
    );
    expect(html).toContain('fill="#FCFF52"');
    expect(html).toContain("<title>Celo Sepolia</title>");
  });

  it("renders Monad purple for chainId 143", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{ ...BASE, id: "monad-mainnet", chainId: 143, label: "Monad" }}
      />,
    );
    expect(html).toContain('fill="#836EF9"');
    expect(html).toContain("<title>Monad</title>");
  });

  it("renders Monad purple for Monad Testnet chainId 10143", () => {
    const html = renderToStaticMarkup(
      <ChainIcon
        network={{
          ...BASE,
          id: "monad-testnet",
          chainId: 10143,
          label: "Monad Testnet",
          testnet: true,
        }}
      />,
    );
    expect(html).toContain('fill="#836EF9"');
    expect(html).toContain("<title>Monad Testnet</title>");
  });

  it("falls back to generic slate for an unknown chainId", () => {
    const html = renderToStaticMarkup(
      <ChainIcon network={{ ...BASE, chainId: 99999, label: "Some Chain" }} />,
    );
    expect(html).toContain('fill="#64748b"');
    expect(html).toContain("<title>Some Chain</title>");
  });

  it("dims the icon (opacity-60) when network.testnet is true", () => {
    const html = renderToStaticMarkup(
      <ChainIcon network={{ ...BASE, testnet: true, label: "Testy" }} />,
    );
    expect(html).toContain("opacity-60");
  });

  it("does not dim the icon for mainnet networks", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).not.toContain("opacity-60");
  });

  it("exposes network.label via accessible SVG markup", () => {
    const html = renderToStaticMarkup(<ChainIcon network={BASE} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Celo"');
  });
});
