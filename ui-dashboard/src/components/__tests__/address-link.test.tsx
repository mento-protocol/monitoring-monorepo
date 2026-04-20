import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressLink } from "@/components/address-link";

const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      testnet: false,
      hasVirtualPools: true,
      contractsNamespace: "mainnet",
      hasuraUrl: "",
      hasuraSecret: "",
    },
  }),
}));

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (addr: string) => addr.slice(0, 10),
    hasName: () => false,
    isCustom: () => false,
    getEntry: () => null,
  }),
}));

vi.mock("@/components/address-label-editor", () => ({
  AddressLabelEditor: () => null,
}));

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

describe("AddressLink edit-pencil session gate", () => {
  beforeEach(() => {
    mockUseSession.mockReset();
  });

  it("hides the edit pencil when user is not authenticated", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    const html = renderToStaticMarkup(<AddressLink address={ADDR} />);
    expect(html).not.toContain("aria-label");
  });

  it("shows the edit pencil when authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "alice@mentolabs.xyz" } },
      status: "authenticated",
    });
    const html = renderToStaticMarkup(<AddressLink address={ADDR} />);
    expect(html).toContain(`Add label for ${ADDR}`);
  });

  it("readOnly=true hides the pencil even when authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "alice@mentolabs.xyz" } },
      status: "authenticated",
    });
    const html = renderToStaticMarkup(<AddressLink address={ADDR} readOnly />);
    expect(html).not.toContain("aria-label");
  });

  it("always renders the explorer link regardless of session", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    const html = renderToStaticMarkup(<AddressLink address={ADDR} />);
    expect(html).toContain(`celoscan.io/address/${ADDR}`);
  });
});
