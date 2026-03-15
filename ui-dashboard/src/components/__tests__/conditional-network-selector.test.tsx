import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionalNetworkSelector } from "@/components/conditional-network-selector";

// Mock usePathname so we can control it per-test
const mockPathname = vi.fn(() => "/");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

// Stub NetworkSelector — we only care whether it renders, not what it looks like
vi.mock("@/components/network-selector", () => ({
  NetworkSelector: () => <div data-testid="network-selector" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConditionalNetworkSelector", () => {
  it("returns null on the global homepage /", () => {
    mockPathname.mockReturnValue("/");
    const html = renderToStaticMarkup(<ConditionalNetworkSelector />);
    expect(html).toBe("");
  });

  it("renders the selector on /pools", () => {
    mockPathname.mockReturnValue("/pools");
    const html = renderToStaticMarkup(<ConditionalNetworkSelector />);
    expect(html).toContain("network-selector");
  });

  it("renders the selector on /pool/0xabc", () => {
    mockPathname.mockReturnValue("/pool/0xabc123");
    const html = renderToStaticMarkup(<ConditionalNetworkSelector />);
    expect(html).toContain("network-selector");
  });

  it("renders the selector on /address-book", () => {
    mockPathname.mockReturnValue("/address-book");
    const html = renderToStaticMarkup(<ConditionalNetworkSelector />);
    expect(html).toContain("network-selector");
  });
});
