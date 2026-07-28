/** @vitest-environment jsdom */

/**
 * Interactive URL-state smoke tests for EntitySearch. Covers lazy-init from
 * URL, search/page writes to URL, query change resets page to 1, popstate
 * sync, and bookmark-share survival via the useSearchParams SSR-pass.
 *
 * IntelTransfers reuses the same pattern (?page= only) — wrong param name
 * or missing popstate listener there would still pass these tests, but the
 * shape of the regression would surface in code review since the helpers
 * are inlined identically.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let container: HTMLElement | null = null;
let root: Root | null = null;

const SLUGS = [
  ...Array.from(
    { length: 120 },
    (_, i) => `alpha-${String(i).padStart(3, "0")}`,
  ),
  "beta-zero",
  "beta-one",
  "gamma-zero",
];
const ITEMS: EntityDirectoryItem[] = SLUGS.map((slug) => ({
  slug,
  name: slug === "gamma-zero" ? "Gamma Exchange" : slug,
  type: null,
  addressCount: 0,
  tags: [],
  searchText:
    slug === "gamma-zero"
      ? `${slug}\ngamma exchange\n0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
      : slug,
}));

function setUrl(qs: string): void {
  const search = qs ? `?${qs}` : "";
  mockSearchParams = new URLSearchParams(qs);
  window.history.replaceState({}, "", `/address-book/entities${search}`);
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<EntitySearch items={ITEMS} addressSearchLimit={50} />);
  });
}

function searchInput(): HTMLInputElement {
  const el = container?.querySelector<HTMLInputElement>(
    'input[aria-label="Search entities"]',
  );
  expect(el).toBeTruthy();
  return el as HTMLInputElement;
}

function typeSearch(value: string): void {
  const input = searchInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(label: string): void {
  const button = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((b) => b.textContent?.includes(label));
  expect(button).toBeTruthy();
  act(() => {
    button?.click();
  });
}

function pageStatus(): string {
  const el = container?.querySelector<HTMLSpanElement>("span.text-xs");
  return el?.textContent?.trim() ?? "";
}

function firstVisibleSlug(): string {
  return (
    container?.querySelector<HTMLTableRowElement>("tbody tr")?.dataset
      .entitySlug ?? ""
  );
}

beforeEach(() => {
  setUrl("");
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  setUrl("");
});

describe("EntitySearch — URL state", () => {
  it("uses the same compact search and table treatment as Addresses", () => {
    render();
    const input = searchInput();
    expect(input.classList.contains("max-w-sm")).toBe(true);
    expect(input.classList.contains("focus:ring-1")).toBe(true);
    expect(container?.querySelector("ul")).toBeNull();
    expect(
      Array.from(container?.querySelectorAll("thead th") ?? []).map((header) =>
        header.textContent?.trim(),
      ),
    ).toEqual(["Entity", "Type", "Tags", "Addresses", "Slug"]);
  });

  it("lazy-inits page from ?page=", () => {
    setUrl("page=2");
    render();
    expect(pageStatus()).toBe("Page 2 of 2");
    expect(firstVisibleSlug()).toBe("alpha-100");
  });

  it("lazy-inits query from ?q= and filters slugs", () => {
    setUrl("q=beta");
    render();
    expect(searchInput().value).toBe("beta");
    expect(firstVisibleSlug()).toBe("beta-zero");
  });

  it("searches enriched entity names and known addresses", () => {
    render();
    typeSearch("Gamma Exchange");
    expect(firstVisibleSlug()).toBe("gamma-zero");

    typeSearch("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(firstVisibleSlug()).toBe("gamma-zero");
  });

  it("lazy-inits q and page together from URL", () => {
    setUrl("q=alpha&page=2");
    render();
    expect(searchInput().value).toBe("alpha");
    expect(pageStatus()).toBe("Page 2 of 2");
    expect(firstVisibleSlug()).toBe("alpha-100");
  });

  it("typing into search writes ?q= and resets page to 1", () => {
    setUrl("page=2");
    render();
    expect(pageStatus()).toBe("Page 2 of 2");
    typeSearch("beta");
    expect(window.location.search).toBe("?q=beta");
    expect(pageStatus()).toBe("");
    expect(firstVisibleSlug()).toBe("beta-zero");
  });

  it("normalizes whitespace before writing or describing search state", () => {
    render();

    typeSearch("   ");
    expect(window.location.search).toBe("");
    expect(container?.textContent).not.toContain('matching "   "');
    expect(firstVisibleSlug()).toBe("alpha-000");

    typeSearch("  Gamma Exchange  ");
    expect(window.location.search).toBe("?q=Gamma+Exchange");
    expect(container?.querySelector('[role="status"]')?.textContent).toContain(
      'matching "Gamma Exchange"',
    );
    expect(firstVisibleSlug()).toBe("gamma-zero");
  });

  it("clicking Next writes ?page=2 and back to Prev strips it", () => {
    render();
    clickButton("Next");
    expect(window.location.search).toBe("?page=2");
    clickButton("Prev");
    expect(window.location.search).toBe("");
  });

  it("clearing the search field strips ?q= from the URL", () => {
    setUrl("q=beta");
    render();
    typeSearch("");
    expect(window.location.search).toBe("");
  });

  it("canonicalizes ?page=1 (default) to empty URL on mount", () => {
    setUrl("page=1");
    render();
    expect(window.location.search).toBe("");
    expect(pageStatus()).toBe("Page 1 of 2");
  });

  it("canonicalizes malformed ?page=foo to empty URL on mount", () => {
    setUrl("page=foo");
    render();
    expect(window.location.search).toBe("");
    expect(pageStatus()).toBe("Page 1 of 2");
  });

  it("canonicalizes out-of-range ?page=999 to ?page=<clamped> on mount", () => {
    setUrl("page=999");
    render();
    expect(window.location.search).toBe("?page=2");
    expect(pageStatus()).toBe("Page 2 of 2");
  });

  it("canonicalizes ?q=beta&page=999 to ?q=beta (clamped to 1 page) on mount", () => {
    // 2 beta-* slugs fit on one page, so the URL should drop the page param.
    setUrl("q=beta&page=999");
    render();
    expect(window.location.search).toBe("?q=beta");
    expect(searchInput().value).toBe("beta");
  });

  it("popstate sync picks up back/forward URL changes", () => {
    render();
    expect(searchInput().value).toBe("");
    // Simulate a back/forward landing on a different URL state.
    window.history.replaceState({}, "", "/address-book/entities?q=gamma");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(searchInput().value).toBe("gamma");
    expect(firstVisibleSlug()).toBe("gamma-zero");
  });
});
