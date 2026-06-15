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
  it("shows protected links when user is authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "alice@mentolabs.xyz" } },
    });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).toContain("Addresses");
    expect(html).toContain("/address-book");
    expect(html).toContain("Integrations");
    expect(html).toContain("/integrations");
    expect(html).toContain("Revenue");
    expect(html).toContain("/revenue");
  });

  it("hides protected links when user is not authenticated", () => {
    mockUseSession.mockReturnValue({ data: null });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).not.toContain("Addresses");
    expect(html).not.toContain("/address-book");
    expect(html).not.toContain("Integrations");
    expect(html).not.toContain("/integrations");
    expect(html).not.toContain("Revenue");
    expect(html).not.toContain("/revenue");
  });

  it("always shows Pools and home links regardless of auth", () => {
    mockUseSession.mockReturnValue({ data: null });
    const html = renderToStaticMarkup(<NavLinks />);
    expect(html).toContain("Pools");
    expect(html).toContain("/pools");
    expect(html).toContain("Mento Analytics");
  });

  it("places Volume after Pools and before Stables", () => {
    mockUseSession.mockReturnValue({ data: null });
    const html = renderToStaticMarkup(<NavLinks />);
    const hrefs = Array.from(
      html.matchAll(/href="([^"]+)"/g),
      (match) => match[1],
    );

    expect(hrefs).toEqual(
      expect.arrayContaining(["/pools", "/volume", "/stables"]),
    );
    expect(hrefs.indexOf("/volume")).toBe(hrefs.indexOf("/pools") + 1);
    expect(hrefs.indexOf("/stables")).toBe(hrefs.indexOf("/volume") + 1);
  });
});
