import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavLinks } from "@/components/nav-links";

// Stub NetworkAwareLink so we can inspect rendered output without Next.js routing
vi.mock("@/components/network-aware-link", () => ({
  NetworkAwareLink: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

describe("NavLinks", () => {
  it("shows Addresses link when user is authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "alice@mentolabs.xyz" } },
    });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).toContain("Addresses");
    expect(html).toContain("/address-book");
  });

  it("hides Addresses link when user is not authenticated", () => {
    mockUseSession.mockReturnValue({ data: null });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).not.toContain("Addresses");
    expect(html).not.toContain("/address-book");
  });

  it("always shows Pools, Revenue, and home links regardless of auth", () => {
    mockUseSession.mockReturnValue({ data: null });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).toContain("Pools");
    expect(html).toContain("/pools");
    expect(html).toContain("Revenue");
    expect(html).toContain("/revenue");
    expect(html).toContain("Mento Analytics");
  });
});
