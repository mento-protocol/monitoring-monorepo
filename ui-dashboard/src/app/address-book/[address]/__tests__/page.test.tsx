/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const VALID_ADDR = "0x" + "a".repeat(40);

let mockParamsAddress = VALID_ADDR;
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
  }),
}));

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
  mockReplace.mockClear();
  mockGetEntry.mockReset();
  mockGetEntry.mockReturnValue(undefined);
  mockHasReport.mockReset();
  mockHasReport.mockReturnValue(false);
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
