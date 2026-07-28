/**
 * SSR-pass smoke test for EntitySearch URL-state lazy init. JSDOM's
 * interactive test in this folder always hits the `window.location.search`
 * branch — only `renderToStaticMarkup` (Node, no `window`) exercises the
 * `useSearchParams` fallback that load-bears direct page loads.
 *
 * Matches the `revenue-by-pool-table-url-state.test.tsx` pattern.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a
      href={typeof href === "string" ? href : String(href)}
      className={className}
    >
      {children}
    </a>
  ),
}));

import { EntitySearch } from "@/app/address-book/entities/_components/entity-search";
import type { EntityDirectoryItem } from "@/app/address-book/entities/_lib/entity-directory";

const SLUGS = [
  ...Array.from(
    { length: 120 },
    (_, i) => `alpha-${String(i).padStart(3, "0")}`,
  ),
  "beta-zero",
  "gamma-zero",
];
const ITEMS: EntityDirectoryItem[] = SLUGS.map((slug) => ({
  slug,
  name: slug,
  type: null,
  addressCount: 0,
  tags: [],
  searchText: slug,
}));

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
});

describe("EntitySearch — SSR pass reads URL via useSearchParams", () => {
  it("renders the URL-derived query as the input's defaultValue", () => {
    mockSearchParams = new URLSearchParams("q=gamma");
    const html = renderToStaticMarkup(
      <EntitySearch items={ITEMS} addressSearchLimit={50} />,
    );
    expect(html).toMatch(/value="gamma"/);
    expect(html).toMatch(/\/address-book\/entities\/gamma-zero/);
  });

  it("renders the URL-derived page so deep links land on the right slice", () => {
    mockSearchParams = new URLSearchParams("page=2");
    const html = renderToStaticMarkup(
      <EntitySearch items={ITEMS} addressSearchLimit={50} />,
    );
    expect(html).toMatch(/Page 2 of 2/);
    expect(html).toMatch(/\/address-book\/entities\/alpha-100/);
  });

  it("falls back to defaults when URL has no params", () => {
    const html = renderToStaticMarkup(
      <EntitySearch items={ITEMS} addressSearchLimit={50} />,
    );
    expect(html).toMatch(/value=""/);
    expect(html).toMatch(/Page 1 of 2/);
    expect(html).toMatch(/\/address-book\/entities\/alpha-000/);
  });
});
