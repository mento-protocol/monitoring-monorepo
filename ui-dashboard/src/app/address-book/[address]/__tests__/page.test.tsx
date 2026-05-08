/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const VALID_ADDR = "0x" + "a".repeat(40);

let mockParamsAddress = VALID_ADDR;
let mockLabelsLoading = false;
let mockLabelsError: Error | undefined = undefined;
const mockReplace = vi.fn();
const mockGetEntry = vi.fn();
const mockHasReport = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ address: mockParamsAddress }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}));

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getEntry: mockGetEntry,
    upsertEntry: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => undefined),
    isCustom: () => false,
    customEntries: [],
    isLoading: mockLabelsLoading,
    error: mockLabelsError,
  }),
}));

// Stub the contract-row lookup so tests don't depend on the live registry —
// the unit tests for `findContractInitial` cover the real walk separately.
const mockFindContractInitial = vi.fn();
vi.mock("../../_lib/address-book-rows", async () => {
  const actual = await vi.importActual<
    typeof import("../../_lib/address-book-rows")
  >("../../_lib/address-book-rows");
  return {
    ...actual,
    findContractInitial: (addr: string) => mockFindContractInitial(addr),
  };
});

vi.mock("@/hooks/use-address-reports-index", () => ({
  useAddressReportsIndex: () => ({
    hasReport: mockHasReport,
  }),
}));

// Stub the heavy report editor — its own SWR fetches require a session,
// and this test focuses on the page composition (header + form + report
// editor mount), not the report editor's internal behavior.
vi.mock("@/components/address-report-editor", () => ({
  AddressReportEditor: ({ address }: { address: string }) => (
    <div data-testid="report-editor" data-address={address}>
      report editor stub
    </div>
  ),
}));

// Stub TagInput — uses ResizeObserver internally, jsdom has none.
vi.mock("@/components/tag-input", () => ({
  TagInput: ({ tags }: { tags: string[] }) => (
    <input data-testid="tag-input-stub" defaultValue={tags.join(",")} />
  ),
}));

import AddressDetailPage from "../page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockParamsAddress = VALID_ADDR;
  mockLabelsLoading = false;
  mockLabelsError = undefined;
  mockReplace.mockClear();
  mockGetEntry.mockReset();
  mockGetEntry.mockReturnValue(undefined);
  mockHasReport.mockReset();
  mockHasReport.mockReturnValue(false);
  mockFindContractInitial.mockReset();
  mockFindContractInitial.mockReturnValue(undefined);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render() {
  act(() => {
    root.render(<AddressDetailPage />);
  });
}

describe("AddressDetailPage — invalid address", () => {
  it("redirects to /address-book and renders nothing", () => {
    mockParamsAddress = "not-an-address";
    render();
    expect(mockReplace).toHaveBeenCalledWith("/address-book");
    expect(container.textContent).toBe("");
  });

  it("redirects gracefully on a malformed percent-encoded URL (e.g. /%zz) instead of throwing", () => {
    // Cursor flagged that an unguarded `decodeURIComponent` would throw
    // `URIError` and dump the user into the error boundary. Pin the
    // try-catch fallback: malformed input falls through to
    // `isValidAddress` (returns false) → silent redirect, same UX as any
    // other garbage path.
    mockParamsAddress = "%zz";
    expect(() => render()).not.toThrow();
    expect(mockReplace).toHaveBeenCalledWith("/address-book");
    expect(container.textContent).toBe("");
  });
});

describe("AddressDetailPage — empty state", () => {
  it("renders the empty form + empty report editor + hint when no data exists", () => {
    mockGetEntry.mockReturnValue(undefined);
    mockHasReport.mockReturnValue(false);
    render();

    // Header shows truncated address as the h1 fallback
    expect(container.querySelector("h1")?.textContent).toContain("0xaaaa");
    // Empty-state hint
    expect(container.textContent).toMatch(/No label or report yet/);
    // Form mounts (input fields rendered)
    expect(container.querySelector("#al-name")).not.toBeNull();
    // Report editor stub mounts
    const stub = container.querySelector('[data-testid="report-editor"]');
    expect(stub?.getAttribute("data-address")).toBe(VALID_ADDR);
    // No report indicator
    expect(
      container.querySelector('[aria-label="Has forensic report"]'),
    ).toBeNull();
  });
});

describe("AddressDetailPage — populated state", () => {
  it("renders the label name in h1 and shows source/all-chains pills", () => {
    mockGetEntry.mockReturnValue({
      entry: {
        name: "Arbitrage Executor",
        tags: ["mev", "bot"],
        source: "arkham",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    mockHasReport.mockReturnValue(true);
    render();

    expect(container.querySelector("h1")?.textContent).toContain(
      "Arbitrage Executor",
    );
    // 📄 indicator visible because hasReport returned true
    expect(
      container.querySelector('[aria-label="Has forensic report"]'),
    ).not.toBeNull();
    // Arkham source badge present
    expect(container.textContent).toContain("arkham");
    // All chains pill present (custom labels are chain-agnostic)
    expect(container.textContent).toContain("All chains");
    // Tag pills (filtered to display tags only, no provenance sentinels)
    expect(container.textContent).toContain("mev");
    expect(container.textContent).toContain("bot");
    // No empty-state hint
    expect(container.textContent).not.toMatch(/No label or report yet/);
  });

  it("normalizes mixed-case URL params to lowercase before lookup", () => {
    const upper = "0x" + "A".repeat(40);
    mockParamsAddress = upper;
    render();
    // Provider lookup is case-sensitive on the call site; assert we lowered
    // before passing through.
    const calls = mockGetEntry.mock.calls;
    expect(calls[0]?.[0]).toBe(upper.toLowerCase());
  });

  it("forwards the address to the report editor verbatim (already lowercased)", () => {
    render();
    const stub = container.querySelector('[data-testid="report-editor"]');
    expect(stub?.getAttribute("data-address")).toBe(VALID_ADDR);
  });
});

describe("AddressDetailPage — labels loading state", () => {
  it("defers form render while labels SWR is in flight (no entry seeded from undefined)", () => {
    mockLabelsLoading = true;
    mockGetEntry.mockReturnValue(undefined);
    render();

    // Skeleton aria-label present, real form input absent
    expect(
      container.querySelector('[aria-label="Loading label form"]'),
    ).not.toBeNull();
    expect(container.querySelector("#al-name")).toBeNull();
    // Header still renders (has truncated address)
    expect(container.querySelector("h1")?.textContent).toContain("0xaaaa");
    // Report editor still mounts — its own SWR drives its own loading state
    expect(
      container.querySelector('[data-testid="report-editor"]'),
    ).not.toBeNull();
  });

  it("falls through to the form when labels SWR errors so the user can still enter a label", () => {
    mockLabelsLoading = false;
    mockLabelsError = new Error("boom");
    mockGetEntry.mockReturnValue(undefined);
    render();

    // No skeleton, real form present
    expect(
      container.querySelector('[aria-label="Loading label form"]'),
    ).toBeNull();
    expect(container.querySelector("#al-name")).not.toBeNull();
  });
});

describe("AddressDetailPage — contract row fallback", () => {
  it("seeds the form with the static contract name when no custom label exists", () => {
    mockGetEntry.mockReturnValue(undefined);
    mockFindContractInitial.mockReturnValue({
      name: "BiPoolManager",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    render();

    // Header shows the contract name (not just truncated address)
    expect(container.querySelector("h1")?.textContent).toContain(
      "BiPoolManager",
    );
    // Form name input is pre-filled with the contract name so an in-place
    // save keeps the registry display name instead of overwriting to empty.
    const nameInput = container.querySelector<HTMLInputElement>("#al-name");
    expect(nameInput?.value).toBe("BiPoolManager");
    // The page should still treat this as `Add label` (no custom entry yet),
    // not "Edit label" — the contract row is the pre-fill, not the saved entry.
    expect(container.textContent).toContain("Add label");
    expect(mockFindContractInitial).toHaveBeenCalledWith(VALID_ADDR);
  });
});
