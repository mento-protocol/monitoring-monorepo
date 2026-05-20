import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/lib/networks";
import { TxHashCell } from "@/components/tx-hash-cell";

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORKS["celo-mainnet"] }),
}));

const TX_HASH =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

function renderCell(chainId?: number): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <tr>
          <TxHashCell txHash={TX_HASH} chainId={chainId} />
        </tr>
      </tbody>
    </table>,
  );
}

describe("TxHashCell", () => {
  it("uses the row chain explorer even when context network differs", () => {
    const html = renderCell(143);
    expect(html).toContain("tx/0x1234567890abcdef");
    expect(html).toContain("monad");
    expect(html).not.toContain("celoscan.io/tx");
  });

  it("does not fall back to context explorer for an unknown row chain", () => {
    const html = renderCell(999_999);
    expect(html).toContain("0x1234");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("celoscan.io/tx");
  });

  it("keeps context explorer fallback only when chainId is omitted", () => {
    const html = renderCell();
    expect(html).toContain("celoscan.io/tx");
  });
});
