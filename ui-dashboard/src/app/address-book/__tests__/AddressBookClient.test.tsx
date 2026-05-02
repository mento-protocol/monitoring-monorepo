/** @vitest-environment jsdom */

// Tell React 19 we're in an act-compatible test environment so legitimate
// state-update warnings stay visible (and so the harness stops printing
// "The current testing environment is not configured to support act(...)"
// to stderr on every render in this suite).
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Characterization tests for `AddressBookClient` — pinned BEFORE the planned
 * row + import-dialog extractions so a mechanical refactor can be verified by
 * keeping every assertion green.
 *
 * Strategy:
 * - Stub `useAddressLabels`, `useNetwork`, `AddressLabelEditor`, and fetch so
 *   the page renders deterministically with no network surprises.
 * - Treat `NETWORKS` as configured in this environment so contract rows
 *   surface — `isConfiguredNetworkId` defaults to `false` without env vars.
 *   Clear every network's addressLabels and seed two synthetic contracts so
 *   real devnet/testnet labels can't bleed into search-count assertions.
 * - Tests rely on the ACTUAL `buildAddressBookRows` helper (used by
 *   `row-composition.test.ts`), so dedupe/order invariants stay shared.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IndexerNetworkId } from "@/lib/networks";
import type { AddressEntryRow } from "@/components/address-labels-provider";

// ---- Module mocks ----------------------------------------------------------
//
// All mocks are declared before the AddressBookClient import below so vitest
// hoists them ahead of any transitive resolution.

let mockCustomEntries: AddressEntryRow[] = [];
const mockGetEntry = vi.fn();
const mockRevalidate = vi.fn(async () => {
  /* no-op */
});

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    customEntries: mockCustomEntries,
    getEntry: mockGetEntry,
    revalidate: mockRevalidate,
    isLoading: false,
    error: undefined,
  }),
}));

// AddressBookClient calls `useNetwork()` to compute the chain context for the
// editor's "Only on X" target. Pin to celo-mainnet so the chainId is a known
// constant in assertions.
vi.mock("@/components/network-provider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/networks")>("@/lib/networks");
  return {
    useNetwork: () => ({
      network: actual.NETWORKS["celo-mainnet"],
      networkId: "celo-mainnet" as IndexerNetworkId,
    }),
  };
});

// Treat every known IndexerNetworkId as configured (the production check
// requires env-derived hasuraUrl, which is empty under vitest). Without this
// every contract-row test would observe an empty contract list.
vi.mock("@/lib/networks", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/networks")>("@/lib/networks");
  // Hermetic test fixture: clear addressLabels on every network (devnet /
  // local / testnets carry real labels in production config and would bleed
  // into search-count assertions otherwise), then seed the two synthetic
  // contracts the suite asserts against. Mutation is safe because vitest
  // worker isolation keeps it scoped.
  for (const id of Object.keys(actual.NETWORKS) as IndexerNetworkId[]) {
    actual.NETWORKS[id].addressLabels = {};
  }
  actual.NETWORKS["celo-mainnet"].addressLabels = {
    "0xcccccccccccccccccccccccccccccccccccccccc": "ContractC",
  };
  if (actual.NETWORKS["monad-mainnet"]) {
    actual.NETWORKS["monad-mainnet"].addressLabels = {
      "0xdddddddddddddddddddddddddddddddddddddddd": "ContractD",
    };
  }
  return {
    ...actual,
    isConfiguredNetworkId: (v: string): v is IndexerNetworkId =>
      v in actual.NETWORKS,
  };
});

// Stub the editor — the page renders it as a child component, but we only
// care that it shows up with the right props. Capturing those props lets us
// assert opening, cancelling, and saving without exercising the editor's own
// network/auth surface.
type CapturedEditor = {
  address: string;
  initial?: { name?: string; tags?: string[] };
  scope?: "global" | number;
  chainId?: number;
  onClose: () => void;
};
let capturedEditor: CapturedEditor | null = null;

vi.mock("@/components/address-label-editor", () => ({
  AddressLabelEditor: (props: CapturedEditor) => {
    capturedEditor = props;
    return (
      <div
        data-testid="editor-stub"
        data-address={props.address}
        data-scope={
          props.scope === undefined
            ? "undefined"
            : typeof props.scope === "number"
              ? `chain:${props.scope}`
              : props.scope
        }
      />
    );
  },
}));

// Other small components — keep their real implementations; they're cheap
// presentational pieces and tested elsewhere. We only need to override the
// ones that pull in browser-incompatible deps or huge subtrees.
vi.mock("@/components/chain-icon", () => ({
  ChainIcon: () => <span data-testid="chain-icon" />,
}));

// TagPills uses ResizeObserver internally — jsdom doesn't ship one, so stub
// it down to a plain inline list of pill strings. The display logic is
// covered by tag-pills.test.tsx in isolation; here we only care that the row
// renders the right tags.
vi.mock("@/components/tag-pills", () => ({
  TagPills: ({ tags }: { tags: string[] }) => (
    <span data-testid="tag-pills">{tags.join(",")}</span>
  ),
}));

// ---- Imports under test ----------------------------------------------------

import AddressBookClient from "../AddressBookClient";
import { NETWORKS } from "@/lib/networks";

// ---- DOM setup -------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let fetchMock: Mock;
let anchorClicks: HTMLAnchorElement[];
let anchorClickSpy: Mock;
let originalCreateElement: typeof document.createElement;

function render(canEdit = true) {
  act(() => {
    root.render(<AddressBookClient canEdit={canEdit} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  mockCustomEntries = [];
  mockGetEntry.mockReset();
  mockGetEntry.mockReturnValue(undefined);
  mockRevalidate.mockClear();

  capturedEditor = null;

  // Track every <a> generated by handleExport so we can verify .click() fires
  // and .href / .download were assigned. We avoid replacing every createElement
  // — only intercept anchors generated *after* render, so React's own DOM
  // construction is untouched.
  anchorClicks = [];
  anchorClickSpy = vi.fn();
  originalCreateElement = document.createElement.bind(document);

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  // Restore createElement if any test patched it.
  document.createElement = originalCreateElement;
});

// ---- Helpers ---------------------------------------------------------------

function customEntry(
  overrides: Partial<AddressEntryRow> = {},
): AddressEntryRow {
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: "global",
    name: "Custom Whale",
    tags: ["whale"],
    notes: undefined,
    isPublic: false,
    source: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function clickByText(text: string): void {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (!target) {
    throw new Error(
      `clickByText: no <button> with text "${text}" — found: ${buttons
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  act(() => {
    target.click();
  });
}

function rowAddresses(): string[] {
  // Each row's address cell carries a `title={address}` (via either the
  // explorer link or the plain-text fallback) — the cleanest way to read the
  // full untruncated address.
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) => {
    const cell = tr.querySelectorAll("td")[1];
    const a = cell?.querySelector("[title]");
    return a?.getAttribute("title") ?? "";
  });
}

function rowCount(): number {
  return container.querySelectorAll("tbody tr").length;
}

function tbodyBadges(): string[] {
  return Array.from(container.querySelectorAll("tbody td span"))
    .map((s) => s.textContent?.trim() ?? "")
    .filter(Boolean);
}

async function dispatchFile(
  fileInput: HTMLInputElement,
  content: string,
  type: string,
  filename: string,
): Promise<void> {
  const file = new File([content], filename, { type });
  // jsdom doesn't expose a writable .files setter; patch the descriptor and
  // dispatch the change event so the React handler picks up the file.
  Object.defineProperty(fileInput, "files", {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Drain microtasks so any chained promises in the handler complete before
  // the assertion. Three resolves covers FileReader → fetch → revalidate.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getFileInput(): HTMLInputElement {
  const fileInput =
    container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) throw new Error("file input not found");
  return fileInput;
}

function setSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search address book"]',
  );
  if (!input) throw new Error("search input not found");
  act(() => {
    // React 19 controlled-input update: set the value, then dispatch input.
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ---- 1. Initial render -----------------------------------------------------

describe("AddressBookClient — initial render", () => {
  it("renders the empty-state copy when no contract or custom rows exist", () => {
    // Drop every NETWORKS entry's addressLabels for this test only — both
    // the contract row source and the custom entry list have to be empty
    // for the empty-state copy to render.
    const original = new Map<string, Record<string, string>>();
    for (const id of Object.keys(NETWORKS)) {
      const k = id as IndexerNetworkId;
      original.set(id, NETWORKS[k].addressLabels);
      NETWORKS[k].addressLabels = {};
    }
    try {
      render();
      expect(container.textContent).toContain("No labels yet. Add one!");
      expect(container.querySelector("table")).toBeNull();
    } finally {
      for (const [id, labels] of original) {
        NETWORKS[id as IndexerNetworkId].addressLabels = labels;
      }
    }
  });

  it("renders one row per contract+custom entry when data exists", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "Custom A",
      }),
    ];
    render();
    const rows = rowCount();
    // 1 custom row + ≥1 contract row (we seeded ContractC and ContractD).
    expect(rows).toBeGreaterThanOrEqual(2);
    // The custom row's address should be present.
    expect(rowAddresses()).toContain(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("renders the page title and description headings", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("Address Book");
    expect(container.textContent).toContain(
      "Contract and custom labels across every chain",
    );
  });

  it("hides edit controls when canEdit=false (read-only middleware bypass)", () => {
    mockCustomEntries = [customEntry()];
    render(false);
    expect(container.textContent).not.toContain("+ Add label");
    expect(container.textContent).not.toContain("Export JSON");
    expect(container.textContent).not.toContain("Import");
  });
});

// ---- 2. Search filter ------------------------------------------------------

describe("AddressBookClient — search filter", () => {
  beforeEach(() => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "Whale Alice",
        tags: ["whale", "cex"],
        scope: "global",
      }),
      customEntry({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "Bob Custodian",
        tags: ["unique-tag-xyz"],
        scope: 42220,
      }),
    ];
  });

  it("matches by address substring (lowercased)", () => {
    render();
    const before = rowCount();
    setSearch("aaaaaaaa");
    const after = rowCount();
    expect(after).toBeLessThan(before);
    expect(rowAddresses().every((a) => a.includes("aaaaaaaa"))).toBe(true);
  });

  it("matches by name substring", () => {
    render();
    setSearch("Whale Alice");
    expect(rowCount()).toBe(1);
  });

  it("matches by tag", () => {
    render();
    setSearch("unique-tag-xyz");
    // Only the row with this tag matches; nothing else in fixtures has it.
    expect(rowCount()).toBe(1);
    expect(rowAddresses()[0]).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("matches by chain text ('all chains' for global scope)", () => {
    render();
    setSearch("all chains");
    expect(rowCount()).toBe(1);
    expect(rowAddresses()[0]).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("matches by source badge text ('contract')", () => {
    render();
    setSearch("contract");
    // Both seeded contract rows match; custom rows do not.
    const matches = rowAddresses();
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toContain("0xcccccccccccccccccccccccccccccccccccccccc");
    expect(matches).not.toContain("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("matches by source badge text ('arkham')", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        name: "Arkham Entry",
        source: "arkham",
        tags: [],
      }),
    ];
    render();
    setSearch("arkham");
    expect(rowAddresses()).toContain(
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );
  });

  it("shows 'No labels match your search.' when search yields zero rows", () => {
    render();
    setSearch("nonexistent-substring-zzz");
    expect(rowCount()).toBe(0);
    expect(container.textContent).toContain("No labels match your search.");
  });

  it("clearing the search restores all rows", () => {
    render();
    const total = rowCount();
    setSearch("Whale Alice");
    expect(rowCount()).toBeLessThan(total);
    setSearch("");
    expect(rowCount()).toBe(total);
  });
});

// ---- 3. Edit modal ---------------------------------------------------------

describe("AddressBookClient — edit modal", () => {
  it("opens the editor with the row's address when 'Edit' is clicked on a custom row", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "Editable",
      }),
    ];
    mockGetEntry.mockReturnValue({
      entry: {
        name: "Editable",
        tags: ["whale"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      scope: "global",
    });
    render();
    expect(capturedEditor).toBeNull();
    clickByText("Edit");
    expect(capturedEditor).not.toBeNull();
    expect(capturedEditor?.address).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("passes the resolved entry's existing values via `initial` prop", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ];
    const resolvedEntry = {
      name: "Existing Name",
      tags: ["whale"],
      notes: "some notes",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockGetEntry.mockReturnValue({ entry: resolvedEntry, scope: "global" });
    render();
    clickByText("Edit");
    expect(capturedEditor?.initial?.name).toBe("Existing Name");
    expect(capturedEditor?.initial?.tags).toEqual(["whale"]);
  });

  it("invoking onClose closes the editor (no further renders)", () => {
    mockCustomEntries = [customEntry()];
    mockGetEntry.mockReturnValue({
      entry: { name: "X", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      scope: "global",
    });
    render();
    clickByText("Edit");
    expect(capturedEditor).not.toBeNull();
    const onClose = capturedEditor!.onClose;
    act(() => {
      onClose();
    });
    expect(container.querySelector('[data-testid="editor-stub"]')).toBeNull();
  });

  it("contract rows render '+ Tag' which opens the editor with scope=global", () => {
    // No custom entries — only synthetic contracts from the mocked NETWORKS.
    mockCustomEntries = [];
    mockGetEntry.mockReturnValue(undefined);
    render();
    clickByText("+ Tag");
    expect(capturedEditor).not.toBeNull();
    expect(capturedEditor?.scope).toBe("global");
  });

  it("contract row's '+ Tag' targets the row's own chain (not the page's first chain)", () => {
    // Regression for a refactor that lost the per-row chain context: targets
    // the Monad ContractD row (chainId 143), not the Celo ContractC row, so
    // any code path that hard-codes the first chain for every row's editor
    // would fail this assertion. Editor `initial` should also carry the
    // contract's name as a default.
    mockCustomEntries = [];
    mockGetEntry.mockReturnValue(undefined);
    render();
    // Find the +Tag button on the row whose address cell carries ContractD.
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const monadRow = rows.find((tr) => tr.textContent?.includes("ContractD"));
    if (!monadRow) {
      throw new Error("ContractD row not found among rendered tbody rows");
    }
    const tagBtn = Array.from(monadRow.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "+ Tag",
    );
    if (!tagBtn) {
      throw new Error("'+ Tag' button missing on Monad ContractD row");
    }
    act(() => {
      tagBtn.click();
    });
    expect(capturedEditor).not.toBeNull();
    expect(capturedEditor?.address).toBe(
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );
    expect(capturedEditor?.scope).toBe("global");
    expect(capturedEditor?.chainId).toBe(143);
    expect(capturedEditor?.initial?.name).toBe("ContractD");
  });
});

// ---- 4. Add new modal ------------------------------------------------------

describe("AddressBookClient — add-new flow", () => {
  it("opens an empty editor when '+ Add label' is clicked", () => {
    render();
    expect(capturedEditor).toBeNull();
    clickByText("+ Add label");
    expect(capturedEditor).not.toBeNull();
    // Empty-address signals "new entry" mode in the editor (per its props
    // contract: pass empty string to allow the user to type a new address).
    expect(capturedEditor?.address).toBe("");
  });

  it("closing the add-new editor clears it from the DOM", () => {
    render();
    clickByText("+ Add label");
    const onClose = capturedEditor!.onClose;
    act(() => {
      onClose();
    });
    expect(container.querySelector('[data-testid="editor-stub"]')).toBeNull();
  });
});

// ---- 5. Export -------------------------------------------------------------

describe("AddressBookClient — export", () => {
  it("'Export JSON' click creates an anchor with the export URL and clicks it", () => {
    // Wrap createElement so we can intercept the synthesized <a>, and stub
    // its `.click()` so we can assert the download was actually triggered
    // (not just the URL written). Without the click() assertion the test
    // would pass even if `handleExport` stopped invoking it.
    const realCreate = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") {
        const anchor = el as HTMLAnchorElement;
        anchor.click = anchorClickSpy;
        anchorClicks.push(anchor);
      }
      return el;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    render();
    clickByText("Export JSON");

    const exportAnchor = anchorClicks.find((a) =>
      a.href.includes("/api/address-labels/export"),
    );
    expect(exportAnchor).toBeDefined();
    expect(exportAnchor!.download).toBe("");
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);

    document.createElement = realCreate;
  });
});

// ---- 6. Import: CSV --------------------------------------------------------

describe("AddressBookClient — CSV import", () => {
  it("posts CSV body with text/csv content-type and revalidates on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ imported: { global: 1, chains: {} } }), {
        status: 200,
      }),
    );
    render();
    await dispatchFile(
      getFileInput(),
      "address,name,tags,chainId\n0xabc,Whale,,42220\n",
      "text/csv",
      "labels.csv",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/address-labels/import");
    expect((init as RequestInit).method).toBe("POST");
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "text/csv",
    });
    expect(typeof (init as RequestInit).body).toBe("string");
    expect((init as RequestInit).body as string).toContain("address,name,tags");
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("renders an error message when the import endpoint returns a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Bad CSV" }), { status: 400 }),
    );
    render();
    await dispatchFile(
      getFileInput(),
      "address,name\n0xabc,Whale\n",
      "text/csv",
      "broken.csv",
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Bad CSV",
    );
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

// ---- 7. Import: JSON variants ---------------------------------------------

describe("AddressBookClient — JSON import variants", () => {
  async function importJson(payload: unknown, filename = "labels.json") {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ imported: { global: 0, chains: { "42220": 1 } } }),
        { status: 200 },
      ),
    );
    render();
    await dispatchFile(
      getFileInput(),
      JSON.stringify(payload),
      "application/json",
      filename,
    );
  }

  it("Snapshot format — POSTs application/json with the snapshot body", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          "0xabc": {
            name: "Whale",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    };
    await importJson(snapshot, "snapshot.json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/address-labels/import");
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(snapshot);
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("Gnosis Safe format — POSTs the address-list array as application/json", async () => {
    const safe = [
      { address: "0xabc", chainId: "42220", name: "My Label" },
      { address: "0xdef", chainId: "1", name: "Mainnet Label" },
    ];
    await importJson(safe, "safe.json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(safe);
  });

  it("Simple format — POSTs single-chain object as application/json", async () => {
    const simple = {
      chainId: 42220,
      labels: {
        "0xabc": {
          name: "Whale",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    };
    await importJson(simple, "simple.json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(simple);
  });

  it("invalid JSON — surfaces a parse error without calling fetch", async () => {
    render();
    await dispatchFile(
      getFileInput(),
      "{not json",
      "application/json",
      "broken.json",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid file",
    );
  });
});

// ---- 8. Source / visibility badges ----------------------------------------

describe("AddressBookClient — badges", () => {
  it("renders the 'contract' badge for static contract rows", () => {
    mockCustomEntries = [];
    render();
    expect(tbodyBadges()).toContain("contract");
  });

  it("renders the 'custom' source badge for user-created rows without provenance", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: undefined,
        tags: [],
      }),
    ];
    mockGetEntry.mockReturnValue({
      entry: { name: "X", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      scope: "global",
    });
    render();
    expect(tbodyBadges()).toContain("custom");
  });

  it("renders the 'arkham' source badge for arkham-sourced rows", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "arkham",
        tags: [],
      }),
    ];
    mockGetEntry.mockReturnValue({
      entry: {
        name: "X",
        tags: [],
        source: "arkham",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      scope: "global",
    });
    render();
    expect(tbodyBadges()).toContain("arkham");
  });

  it("renders the 'All chains' chain pill for global custom rows", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scope: "global",
      }),
    ];
    render();
    expect(tbodyBadges()).toContain("All chains");
  });

  it("renders 'public' / 'private' visibility for custom rows based on isPublic", () => {
    mockCustomEntries = [
      customEntry({
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scope: "global",
      }),
    ];
    mockGetEntry.mockReturnValue({
      entry: {
        name: "X",
        tags: [],
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      scope: "global",
    });
    render();
    expect(tbodyBadges()).toContain("public");

    // Re-render with isPublic=false → 'private'.
    mockGetEntry.mockReturnValue({
      entry: {
        name: "X",
        tags: [],
        isPublic: false,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      scope: "global",
    });
    render();
    expect(tbodyBadges()).toContain("private");
  });
});
