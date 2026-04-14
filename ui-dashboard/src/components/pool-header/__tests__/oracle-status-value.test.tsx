import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { OracleStatusValue } from "@/components/pool-header/oracle-status-value";

const MOCK_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const BASE_POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  oracleExpiry: "300",
};

const nowSeconds = Math.floor(Date.now() / 1000);
const FRESH_TS = String(nowSeconds - 60); // 60s old, well within 300s threshold
const STALE_TS = String(nowSeconds - 600); // 10min old, beyond 300s threshold

describe("OracleStatusValue", () => {
  it("renders ✓ Fresh when the oracle is fresh", () => {
    const pool: Pool = { ...BASE_POOL, oracleTimestamp: FRESH_TS };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).toContain("✓ Fresh");
    expect(html).toContain("text-emerald-400");
  });

  it("renders ✗ Stale when the oracle is stale", () => {
    const pool: Pool = { ...BASE_POOL, oracleTimestamp: STALE_TS };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).toContain("✗ Stale");
    expect(html).toContain("text-red-400");
  });

  it("renders an explorer anchor for Updated … when oracleTxHash is present", () => {
    const pool: Pool = {
      ...BASE_POOL,
      oracleTimestamp: FRESH_TS,
      oracleTxHash: "0xdeadbeef",
    };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).toContain('href="https://celoscan.io/tx/0xdeadbeef"');
    expect(html).toMatch(/Updated [^<]+↗/);
  });

  it("renders plain span for Updated … without oracleTxHash", () => {
    const pool: Pool = {
      ...BASE_POOL,
      oracleTimestamp: FRESH_TS,
      oracleTxHash: undefined,
    };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).toContain("Updated");
    expect(html).not.toContain("/tx/");
  });

  it("omits the Updated row entirely when oracleTimestamp is missing", () => {
    const pool: Pool = { ...BASE_POOL, oracleTimestamp: undefined };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).not.toContain("Updated");
  });

  it('omits the Updated row when oracleTimestamp is the sentinel "0"', () => {
    const pool: Pool = { ...BASE_POOL, oracleTimestamp: "0" };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).not.toContain("Updated");
  });

  it("renders Expires after N minutes and Ns old subtitle with correct minute count", () => {
    // oracleExpiry=300s → 5m (300/60). Age = nowSeconds - FRESH_TS = 60s.
    const pool: Pool = { ...BASE_POOL, oracleTimestamp: FRESH_TS };
    const html = renderToStaticMarkup(
      <OracleStatusValue pool={pool} network={MOCK_NETWORK} />,
    );
    expect(html).toContain("Expires after 5m");
    expect(html).toMatch(/· \d+s old/);
  });
});
