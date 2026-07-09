import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavLinks } from "@/components/nav-links";

const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

describe("NavLinks", () => {
  const publicHrefs = [
    "/",
    "/pools",
    "/volume",
    "/stables",
    "/bridge-flows",
    "/cdps",
  ];

  function hrefsForSession(session: unknown): string[] {
    mockUseSession.mockReturnValue({ data: session });
    const html = renderToStaticMarkup(<NavLinks />);
    return Array.from(html.matchAll(/href="([^"]+)"/g), (match) => {
      const href = match[1];
      if (!href) throw new Error("matched href capture was empty");
      return href;
    });
  }

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
    expect(html).toContain("Entities");
    expect(html).toContain("/entities");
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
    expect(html).not.toContain("Entities");
    expect(html).not.toContain("/entities");
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

  it("keeps public link order stable across auth states", () => {
    const loggedOutPublic = hrefsForSession(null).filter((href) =>
      publicHrefs.includes(href),
    );
    const loggedInPublic = hrefsForSession({
      user: { email: "alice@mentolabs.xyz" },
    }).filter((href) => publicHrefs.includes(href));

    expect(loggedOutPublic).toEqual(publicHrefs);
    expect(loggedInPublic).toEqual(publicHrefs);
  });

  it("appends authenticated links after every public link", () => {
    const hrefs = hrefsForSession({
      user: { email: "alice@mentolabs.xyz" },
    });

    expect(hrefs).toEqual([
      ...publicHrefs,
      "/integrations",
      "/revenue",
      "/address-book",
      "/entities",
    ]);
  });
});
