/** @vitest-environment jsdom */

/**
 * Interactive URL-state smoke tests for IntelTransfers. Parallel to the
 * EntitySearch tests — covers lazy-init from `?page=`, Pagination Next/Prev
 * URL writes, and popstate sync.
 *
 * The EntitySearch test file already exercises the shared URL-state pattern
 * (read helper + write helper + popstate listener). This file's job is to
 * pin the IntelTransfers-specific wiring: the `?page=` param name, the
 * `useSWR`-gated data path, and the Pagination component's `onPageChange`
 * → `updatePage` callback.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntelTransfersRecord } from "@/lib/intel-transfers";

let mockSearchParams = new URLSearchParams();
let mockSwrData: IntelTransfersRecord | null = null;

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

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated" }),
}));

vi.mock("swr", () => ({
  default: () => ({ data: mockSwrData }),
}));

import { IntelTransfers } from "@/app/address-book/[address]/_components/intel-transfers";

const ADDRESS = "0x" + "a".repeat(40);
const COUNTERPARTY = "0x" + "b".repeat(40);

// Minimum shape IntelTransfers actually reads. The full ArkhamTransfer type
// has ~20 fields (address-chain metadata, contract flags, block details);
// stubbing them all would obscure the test. This Pick reflects the
// component's render surface.
type TestTransfer = {
  id: string;
  transactionHash: string;
  fromAddress: { address: string };
  toAddress: { address: string };
  blockTimestamp: string;
  tokenSymbol: string;
  unitValue: number;
  usd: number;
  chain: string;
};

// 51 transfers — one over PAGE_SIZE (50) so two pages exist.
function makeRecord(): IntelTransfersRecord {
  const transfers: TestTransfer[] = Array.from({ length: 51 }, (_, i) => ({
    id: `tx-${String(i).padStart(3, "0")}`,
    // Newest first after the component's descending-timestamp sort. Use
    // unique timestamps so each transfer's row is deterministic.
    transactionHash: "0x" + String(i).padStart(64, "c"),
    fromAddress: { address: COUNTERPARTY },
    toAddress: { address: ADDRESS },
    blockTimestamp: new Date(
      Date.UTC(2026, 4, 28, 12, 0, 51 - i),
    ).toISOString(),
    tokenSymbol: "ETH",
    unitValue: 1,
    usd: 1,
    // Use a chain present in EXPLORER_URLS so each TX cell renders an
    // <a> link — makes the test query deterministic via href matching.
    chain: "ethereum",
  }));
  return {
    address: ADDRESS,
    fetchedAt: "2026-05-28T10:00:00Z",
    transferCount: 51,
    transfers: transfers as IntelTransfersRecord["transfers"],
  };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

function setUrl(qs: string): void {
  const search = qs ? `?${qs}` : "";
  mockSearchParams = new URLSearchParams(qs);
  window.history.replaceState({}, "", `/address-book/${ADDRESS}${search}`);
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<IntelTransfers address={ADDRESS} />);
  });
}

function clickButton(label: string): void {
  const button = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((b) => b.getAttribute("aria-label") === label);
  expect(button, `button "${label}"`).toBeTruthy();
  act(() => {
    button?.click();
  });
}

function pageStatus(): string {
  // The Pagination component renders "<total> total · page X of Y" in a
  // span.text-xs. Other text-xs spans (e.g. fetchedAt) appear in the
  // header but are filtered out by looking for the "page" marker.
  const spans = Array.from(
    container?.querySelectorAll<HTMLSpanElement>("span.text-xs") ?? [],
  );
  const match = spans.find((s) => /page \d+ of \d+/.test(s.textContent ?? ""));
  return match?.textContent?.trim() ?? "";
}

function firstVisibleTxHashSuffix(): string {
  // The TX cell links to etherscan.io/tx/<hash>. Strip the prefix so the
  // assertion targets the hash payload directly.
  const links = Array.from(
    container?.querySelectorAll<HTMLAnchorElement>("tbody a") ?? [],
  );
  const txLink = links.find((a) =>
    (a.getAttribute("href") ?? "").startsWith("https://etherscan.io/tx/"),
  );
  return (txLink?.getAttribute("href") ?? "").replace(
    "https://etherscan.io/tx/",
    "",
  );
}

beforeEach(() => {
  mockSwrData = makeRecord();
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
  mockSwrData = null;
});

describe("IntelTransfers — URL state", () => {
  it("lazy-inits page from ?page=", () => {
    setUrl("page=2");
    render();
    expect(pageStatus()).toMatch(/page 2 of 2/);
    // Page 2 shows only the 51st transfer (oldest after the descending sort,
    // i.e. the original index 50). Its tx hash was padded with "c"s.
    expect(firstVisibleTxHashSuffix()).toBe(
      "0x" + String(50).padStart(64, "c"),
    );
  });

  it("clicking Next writes ?page=2 and back to Prev strips it", () => {
    render();
    expect(window.location.search).toBe("");
    clickButton("Next page");
    expect(window.location.search).toBe("?page=2");
    clickButton("Previous page");
    expect(window.location.search).toBe("");
  });

  it("canonicalizes ?page=1 (default) to empty URL after data lands", () => {
    setUrl("page=1");
    render();
    expect(window.location.search).toBe("");
    expect(pageStatus()).toMatch(/page 1 of 2/);
  });

  it("canonicalizes malformed ?page=foo to empty URL after data lands", () => {
    setUrl("page=foo");
    render();
    expect(window.location.search).toBe("");
    expect(pageStatus()).toMatch(/page 1 of 2/);
  });

  it("canonicalizes out-of-range ?page=999 to ?page=<clamped> after data lands", () => {
    setUrl("page=999");
    render();
    expect(window.location.search).toBe("?page=2");
    expect(pageStatus()).toMatch(/page 2 of 2/);
  });

  it("popstate sync picks up back/forward URL changes", () => {
    render();
    expect(pageStatus()).toMatch(/page 1 of 2/);
    // Simulate the browser back/forward landing on ?page=2.
    window.history.replaceState({}, "", `/address-book/${ADDRESS}?page=2`);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(pageStatus()).toMatch(/page 2 of 2/);
  });
});
