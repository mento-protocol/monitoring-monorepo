/** @vitest-environment jsdom */

/**
 * Characterization tests for `app/bridge-flows/page.tsx`. Pins the page's
 * current behavior so the upcoming TransfersTable + RouteDeliveryTile
 * extractions can be verified mechanical (test set stays green across the
 * refactor).
 *
 * Mocks the minimum dependency surface:
 *   - `useBridgeGQL`     — driven per-query via a query-string discriminator
 *   - `useOracleRates`   — empty rate map by default
 *   - `next/navigation`  — useSearchParams + useRouter for URL-backed state
 *   - `useAddressLabels` — pass-through stub (AddressLink is the only consumer)
 *   - heavy chart components & dialog-mounting children — replaced with stubs
 *
 * The 7 acceptance pins (see PR description) map onto the `describe` blocks
 * below 1:1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BRIDGE_DAILY_SNAPSHOT,
  BRIDGE_DELIVERED_RECENT,
  BRIDGE_PENDING_IDS,
  BRIDGE_TOP_BRIDGERS,
  BRIDGE_TRANSFERS_COUNT,
  BRIDGE_TRANSFERS_WINDOW,
} from "@/lib/bridge-queries";
import type { BridgeStatus, BridgeTransfer } from "@/lib/types";
import { makeTransfer } from "@/lib/bridge-flows/__tests__/fixtures";

// ---------------------------------------------------------------------------
// Mocks (must be declared before the SUT import).
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/bridge-flows",
}));

const mockUseBridgeGQL = vi.fn();
vi.mock("@/lib/bridge-flows/use-bridge-gql", () => ({
  useBridgeGQL: (...args: unknown[]) => mockUseBridgeGQL(...args),
}));

const mockUseOracleRates = vi.fn(() => ({
  byNetwork: [],
  merged: new Map(),
  isLoading: false,
  hasAnyError: false,
}));
vi.mock("@/hooks/use-oracle-rates", () => ({
  useOracleRates: () => mockUseOracleRates(),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "https://example.com/v1/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
  }),
}));

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (a: string | null) => a ?? "—",
    getTags: () => [] as string[],
    getLabel: (a: string | null) => a ?? "—",
    hasName: () => false,
    isCustom: () => false,
    getEntry: () => null,
  }),
}));

// Top-level stub components — extracted so the eslint rule
// `no-nested-component-definitions` doesn't complain about JSX defined inside
// the `vi.mock` factory arrows.
//
// Charts surface `isLoading` via `data-loading` so the loading-matrix tests can
// assert that the page wires per-query loading state through to the chart
// without rendering the full Plotly surface.
function VolumeChartStub({ isLoading }: { isLoading?: boolean }) {
  return (
    <div
      data-testid="volume-chart"
      data-loading={isLoading ? "true" : "false"}
    />
  );
}
function TokenBreakdownChartStub({ isLoading }: { isLoading?: boolean }) {
  return (
    <div
      data-testid="token-breakdown-chart"
      data-loading={isLoading ? "true" : "false"}
    />
  );
}
function TopBridgersChartStub({ isLoading }: { isLoading?: boolean }) {
  return (
    <div
      data-testid="top-bridgers-chart"
      data-loading={isLoading ? "true" : "false"}
    />
  );
}
function RedeemPillStub() {
  return <span data-testid="redeem-pill">redeem</span>;
}
function ToastPortalStub({
  toasts,
}: {
  toasts: Array<{ id: number; message: string }>;
}) {
  return (
    <div data-testid="toast-portal">
      {toasts.map((t) => (
        <div key={t.id} data-testid="toast" data-toast-id={t.id}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
function AddressLinkStub({ address }: { address: string }) {
  return <span data-testid="address-link">{address}</span>;
}
function ChainIconStub() {
  return <span data-testid="chain-icon" />;
}

// Charts mount Plotly via `next/dynamic`; in the node/jsdom environments we
// can't run that pipeline. Stub them out with markers we can assert against.
vi.mock("@/components/bridge-volume-chart", () => ({
  BridgeVolumeChart: VolumeChartStub,
}));
vi.mock("@/components/bridge-token-breakdown-chart", () => ({
  BridgeTokenBreakdownChart: TokenBreakdownChartStub,
}));
vi.mock("@/components/bridge-top-bridgers-chart", () => ({
  BridgeTopBridgersChart: TopBridgersChartStub,
}));

// `BridgeRedeemPill` mounts a `<dialog>` and uses `useSyncExternalStore`;
// the bare ToastPortal is fine to render once stubbed minimally.
vi.mock("@/components/bridge-redeem-cta", () => ({
  BridgeRedeemPill: RedeemPillStub,
  ToastPortal: ToastPortalStub,
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: AddressLinkStub,
}));

vi.mock("@/components/chain-icon", () => ({
  ChainIcon: ChainIconStub,
}));

import BridgeFlowsPage from "../page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type GQLResult<T> = {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
};

function ok<T>(data: T): GQLResult<T> {
  return { data, error: undefined, isLoading: false };
}
function failed<T>(message: string): GQLResult<T> {
  return { data: undefined, error: new Error(message), isLoading: false };
}
/** First-fetch-in-flight: SWR shape with no data yet, no error, isLoading=true. */
function loading<T>(): GQLResult<T> {
  return { data: undefined, error: undefined, isLoading: true };
}

const CELO = 42220;
const MONAD = 143;

/**
 * Three transfer fixtures with monotonically-distinct sentTimestamp,
 * tokenSymbol, sender, route — sorting on any of those keys yields a unique,
 * easy-to-assert order.
 */
// Per-row sender/recipient/txhash fixtures use distinct hex shapes so any
// future production-side hex validation (length / charset) doesn't silently
// pass on these tests. Each tier (new/mid/old) gets a single hex digit so
// substring assertions like `.toContain("0xaaaa")` remain self-explanatory.
const NEW_SENDER = "0x" + "a".repeat(40);
const NEW_RECIPIENT = "0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const MID_SENDER = "0x" + "b".repeat(40);
const MID_RECIPIENT = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const OLD_SENDER = "0x" + "c".repeat(40);
const OLD_RECIPIENT = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";

const T_NEW: BridgeTransfer = makeTransfer({
  id: "wormhole-NEW",
  providerMessageId: "NEW",
  status: "DELIVERED",
  tokenSymbol: "USDm",
  sourceChainId: CELO,
  destChainId: MONAD,
  sender: NEW_SENDER,
  recipient: NEW_RECIPIENT,
  amount: "3000000000000000000",
  sentTimestamp: "3000",
  deliveredTimestamp: "3060",
  sentTxHash: "0x" + "a".repeat(64),
  deliveredTxHash: "0xa1" + "a".repeat(62),
  firstSeenAt: "3000",
});
const T_MID: BridgeTransfer = makeTransfer({
  id: "wormhole-MID",
  providerMessageId: "MID",
  status: "DELIVERED",
  tokenSymbol: "EURm",
  sourceChainId: MONAD,
  destChainId: CELO,
  sender: MID_SENDER,
  recipient: MID_RECIPIENT,
  amount: "2000000000000000000",
  sentTimestamp: "2000",
  deliveredTimestamp: "2120",
  sentTxHash: "0x" + "b".repeat(64),
  deliveredTxHash: "0xb1" + "b".repeat(62),
  firstSeenAt: "2000",
});
const T_OLD: BridgeTransfer = makeTransfer({
  id: "wormhole-OLD",
  providerMessageId: "OLD",
  status: "PENDING",
  tokenSymbol: "GBPm",
  sourceChainId: CELO,
  destChainId: MONAD,
  sender: OLD_SENDER,
  recipient: OLD_RECIPIENT,
  amount: "1000000000000000000",
  sentTimestamp: "1000",
  sentTxHash: "0x" + "c".repeat(64),
  firstSeenAt: "1000",
});

const ALL_THREE_TRANSFERS = [T_NEW, T_MID, T_OLD];

/**
 * Build a `useBridgeGQL` implementation driven by the GraphQL query string.
 * Each query slot can be overridden per test.
 */
function bridgeImpl(
  opts: {
    transfers?: GQLResult<{ BridgeTransfer: BridgeTransfer[] }>;
    count?: GQLResult<{ BridgeTransfer: Array<{ id: string }> }>;
    pending?: GQLResult<{ BridgeTransfer: Array<{ id: string }> }>;
    snapshots?: GQLResult<{ BridgeDailySnapshot: unknown[] }>;
    topBridgers?: GQLResult<{ BridgeBridger: unknown[] }>;
    delivered?: GQLResult<{
      BridgeTransfer: Array<{
        status: BridgeStatus;
        sentTimestamp: string | null;
        deliveredTimestamp: string | null;
        sourceChainId: number | null;
        destChainId: number | null;
      }>;
    }>;
  } = {},
) {
  return (query: string | null) => {
    if (query === BRIDGE_TRANSFERS_WINDOW)
      return opts.transfers ?? ok({ BridgeTransfer: [] });
    if (query === BRIDGE_TRANSFERS_COUNT)
      return opts.count ?? ok({ BridgeTransfer: [] });
    if (query === BRIDGE_PENDING_IDS)
      return opts.pending ?? ok({ BridgeTransfer: [] });
    if (query === BRIDGE_DAILY_SNAPSHOT)
      return opts.snapshots ?? ok({ BridgeDailySnapshot: [] });
    if (query === BRIDGE_TOP_BRIDGERS)
      return opts.topBridgers ?? ok({ BridgeBridger: [] });
    if (query === BRIDGE_DELIVERED_RECENT)
      return opts.delivered ?? ok({ BridgeTransfer: [] });
    return ok({});
  };
}

/** Fixture for filling a page (≥25 rows) so we can exercise the pager. */
function makeBulkTransfers(n: number): BridgeTransfer[] {
  return Array.from({ length: n }, (_, i) =>
    makeTransfer({
      id: `wormhole-bulk-${i}`,
      providerMessageId: `bulk-${i}`,
      status: i % 2 === 0 ? "DELIVERED" : "PENDING",
      tokenSymbol: "USDm",
      sourceChainId: CELO,
      destChainId: MONAD,
      sender: `0x${i.toString(16).padStart(40, "1")}`,
      recipient: `0x${i.toString(16).padStart(40, "2")}`,
      amount: String(BigInt(i + 1) * BigInt(10) ** BigInt(18)),
      sentTimestamp: String(10_000 - i),
      sentTxHash: `0x${i.toString(16).padStart(64, "0")}`,
      firstSeenAt: String(10_000 - i),
    }),
  );
}

// ---------------------------------------------------------------------------
// jsdom render harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

function renderJsdom(): void {
  act(() => {
    root.render(<BridgeFlowsPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  // Default: every query returns empty. Tests override per-slot.
  mockUseBridgeGQL.mockImplementation(bridgeImpl());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

// ---------------------------------------------------------------------------
// 1. Lazy-mount + initial render
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — initial render", () => {
  it("mounts without crashing on the empty default state", () => {
    expect(() => renderJsdom()).not.toThrow();
    // Tighten to the page <h1> so a tooltip / error banner that happens to
    // contain "Bridge Flows" can't satisfy the assertion alone.
    expect(container.querySelector("h1")?.textContent).toContain(
      "Bridge Flows",
    );
  });

  it("renders the page subtitle and key sections", () => {
    renderJsdom();
    // Subtitle lives in a <p> immediately under the heading; scope to that
    // rather than `container.textContent` so the assertion fails loudly if
    // the subtitle is removed or moved into a different element.
    const paragraphs = Array.from(container.querySelectorAll("p"));
    expect(
      paragraphs.some((p) =>
        p.textContent?.includes(
          "Wormhole NTT transfers of Mento stable tokens",
        ),
      ),
    ).toBe(true);
    // Key sections exist in markup.
    expect(container.querySelector('[aria-label="Charts"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Key metrics"]')).toBeTruthy();
    expect(
      container.querySelector('[aria-label="Recent transfers"]'),
    ).toBeTruthy();
  });

  it("renders chart placeholders for all three chart slots", () => {
    renderJsdom();
    expect(
      container.querySelector('[data-testid="volume-chart"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="token-breakdown-chart"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="top-bridgers-chart"]'),
    ).toBeTruthy();
  });

  it("defaults page=1 and status=All when no URL params are set", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: ALL_THREE_TRANSFERS }),
        count: ok({
          BridgeTransfer: ALL_THREE_TRANSFERS.map((t) => ({ id: t.id })),
        }),
      }),
    );
    renderJsdom();
    // 3 total rows; pager renders "3 total" with no page-of-N suffix.
    expect(container.textContent).toContain("3 total");
    // "All" filter pill is the active radio.
    const allPill = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((b) => b.textContent?.trim() === "All");
    expect(allPill?.getAttribute("aria-checked")).toBe("true");
  });

  it("renders the transfers table when transfers are returned", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: ALL_THREE_TRANSFERS }),
        count: ok({
          BridgeTransfer: ALL_THREE_TRANSFERS.map((t) => ({ id: t.id })),
        }),
      }),
    );
    renderJsdom();
    expect(container.querySelector("table")).toBeTruthy();
    // 3 data rows in tbody.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 1b. Loading matrix — every page-level query family in its first-fetch state
// ---------------------------------------------------------------------------
//
// Pins the page-level loading UI for each backing query so an extraction can't
// silently regress a slot to empty/zero state. The original suite was a
// "no-op vs error" axis only (every fixture set isLoading: false), which let
// any of these branches drift unobserved:
//
//   - transfers     -> Skeleton rows below the table header
//   - charts        -> isLoading prop forwarded to chart components
//   - pending       -> "…" pending-count placeholder in the In-Flight tile
//   - delivered     -> 2-bar pulse skeleton inside the RouteDeliveryTile
//
// Each test isolates ONE slot to loading and asserts the expected loading UI
// renders for that slot.

describe("BridgeFlowsPage — loading matrix", () => {
  it("transfers slot loading: renders the table-skeleton instead of EmptyBox", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: loading<{ BridgeTransfer: BridgeTransfer[] }>(),
      }),
    );
    renderJsdom();
    // Skeleton has role="status" + aria-label="Loading"; EmptyBox would have
    // text instead.
    const skel = container.querySelector(
      '[role="status"][aria-label="Loading"]',
    );
    expect(skel).toBeTruthy();
    expect(container.textContent).not.toContain("No bridge transfers yet.");
    // Table header should not have rendered (the skeleton replaces the table
    // entirely on first fetch).
    expect(container.querySelector("table")).toBeNull();
  });

  it("snapshots slot loading: forwards isLoading=true to both BridgeVolumeChart and BridgeTokenBreakdownChart", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        snapshots: loading<{ BridgeDailySnapshot: unknown[] }>(),
      }),
    );
    renderJsdom();
    const volume = container.querySelector('[data-testid="volume-chart"]');
    const tokenBreakdown = container.querySelector(
      '[data-testid="token-breakdown-chart"]',
    );
    expect(volume?.getAttribute("data-loading")).toBe("true");
    expect(tokenBreakdown?.getAttribute("data-loading")).toBe("true");
    // The Total Bridge Transfers BreakdownTile shows "…" instead of N/A.
    // Search the markup specifically inside the Key metrics section for the
    // loading placeholder ("…") so we don't false-positive on the In-Flight
    // tile (which has its own "…" gating on a different query).
    const metrics = container.querySelector('[aria-label="Key metrics"]');
    expect(metrics?.textContent).toContain("…");
    expect(metrics?.textContent).not.toContain("N/A");
  });

  it("topBridgers slot loading: forwards isLoading=true to BridgeTopBridgersChart only", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        topBridgers: loading<{ BridgeBridger: unknown[] }>(),
      }),
    );
    renderJsdom();
    const topBridgers = container.querySelector(
      '[data-testid="top-bridgers-chart"]',
    );
    expect(topBridgers?.getAttribute("data-loading")).toBe("true");
    // Other charts must remain non-loading — independent gating.
    expect(
      container
        .querySelector('[data-testid="volume-chart"]')
        ?.getAttribute("data-loading"),
    ).toBe("false");
  });

  it("pending slot loading: In-Flight tile shows '…' (not '—' or '0')", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        pending: loading<{ BridgeTransfer: Array<{ id: string }> }>(),
      }),
    );
    renderJsdom();
    // The In-Flight tile is the second tile in the Key metrics section.
    const metrics = container.querySelector('[aria-label="Key metrics"]');
    expect(metrics?.textContent).toContain("In-Flight");
    expect(metrics?.textContent).toContain("…");
  });

  it("delivered slot loading: RouteDeliveryTile shows the 2-bar pulse skeleton (not the empty/error message)", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        delivered: loading<{
          BridgeTransfer: Array<{
            status: BridgeStatus;
            sentTimestamp: string | null;
            deliveredTimestamp: string | null;
            sourceChainId: number | null;
            destChainId: number | null;
          }>;
        }>(),
      }),
    );
    renderJsdom();
    // The route tile contains "Avg Delivery Time by Route" as its header and
    // renders 2 .animate-pulse bars while loading. Crucially, it must NOT
    // render the empty-state copy or the em-dash error path.
    expect(container.textContent).toContain("Avg Delivery Time by Route");
    const pulses = container.querySelectorAll(".animate-pulse");
    // Two pulse bars from the route tile (other components may add more
    // pulse skeletons; we only need ≥2 to confirm the route tile is in its
    // loading branch).
    expect(pulses.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain("No delivered transfers yet");
  });
});

// ---------------------------------------------------------------------------
// 2. TransfersTable sort state
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — TransfersTable sort state", () => {
  function setupWithThree(): void {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: ALL_THREE_TRANSFERS }),
        count: ok({
          BridgeTransfer: ALL_THREE_TRANSFERS.map((t) => ({ id: t.id })),
        }),
      }),
    );
  }

  function rowOrder(): string[] {
    // Resolve the Sender column index by header text rather than positional
    // index. If A2 reorders columns, the test stays correct (it always reads
    // the column whose header is "Sender"). If "Sender" is removed entirely
    // we fail loudly here, instead of silently returning data from whatever
    // first AddressLink the row happens to expose.
    const headers = Array.from(container.querySelectorAll("thead th"));
    const senderColIdx = headers.findIndex((th) =>
      th.textContent?.includes("Sender"),
    );
    if (senderColIdx < 0) {
      throw new Error("rowOrder: 'Sender' header not found in thead");
    }
    return Array.from(container.querySelectorAll("tbody tr")).map((tr) => {
      const cell = tr.querySelectorAll("td")[senderColIdx];
      const link = cell?.querySelector('[data-testid="address-link"]');
      return link?.textContent ?? cell?.textContent ?? "";
    });
  }

  function findHeaderButton(label: string): HTMLButtonElement {
    const headers = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("th"),
    );
    for (const header of headers) {
      const btn = header.querySelector<HTMLButtonElement>("button");
      if (btn && btn.textContent?.includes(label)) return btn;
    }
    throw new Error(`No sortable header for ${label}`);
  }

  it("default sort is by Time DESC (newest first)", () => {
    setupWithThree();
    renderJsdom();
    const order = rowOrder();
    // Newest sentTimestamp first.
    expect(order[0]).toContain(NEW_SENDER);
    expect(order[1]).toContain(MID_SENDER);
    expect(order[2]).toContain(OLD_SENDER);
    // Time header is aria-sort=descending.
    const timeBtn = findHeaderButton("Time");
    expect(timeBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });

  it("clicking the active Time header toggles to ascending (oldest first)", () => {
    setupWithThree();
    renderJsdom();
    const timeBtn = findHeaderButton("Time");
    act(() => {
      timeBtn.click();
    });
    const order = rowOrder();
    expect(order[0]).toContain(OLD_SENDER);
    expect(order[1]).toContain(MID_SENDER);
    expect(order[2]).toContain(NEW_SENDER);
    expect(timeBtn.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("clicking Time twice cycles back to descending", () => {
    setupWithThree();
    renderJsdom();
    const timeBtn = findHeaderButton("Time");
    act(() => timeBtn.click());
    act(() => timeBtn.click());
    expect(timeBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });

  it("clicking an inactive header (Token) snaps to Token DESC", () => {
    setupWithThree();
    renderJsdom();
    const tokenBtn = findHeaderButton("Token");
    act(() => {
      tokenBtn.click();
    });
    // Token DESC: USDm > GBPm > EURm? — string descending compare:
    // Sender of T_NEW=USDm, T_OLD=GBPm, T_MID=EURm.
    const order = rowOrder();
    expect(order[0]).toContain(NEW_SENDER); // USDm
    expect(order[1]).toContain(OLD_SENDER); // GBPm
    expect(order[2]).toContain(MID_SENDER); // EURm
    expect(tokenBtn.closest("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    );
    // Time header is no longer active.
    const timeBtn = findHeaderButton("Time");
    expect(timeBtn.closest("th")?.getAttribute("aria-sort")).toBe("none");
  });

  it("clicking Sender header sorts by sender address (DESC)", () => {
    setupWithThree();
    renderJsdom();
    const senderBtn = findHeaderButton("Sender");
    act(() => {
      senderBtn.click();
    });
    const order = rowOrder();
    // sender DESC by lowercase localeCompare:
    //   OLD_SENDER (0xc…) > MID_SENDER (0xb…) > NEW_SENDER (0xa…)
    expect(order[0]).toContain(OLD_SENDER);
    expect(order[1]).toContain(MID_SENDER);
    expect(order[2]).toContain(NEW_SENDER);
  });

  // ----- Route / Amount / Duration comparator coverage -----
  //
  // These three comparators are the risky ones in `sortTransfers()`:
  //
  //   - route    -> custom NUMERIC ordering on (sourceChainId, destChainId).
  //                 A lex sort would put "143-…" < "42220-…" because "1" <
  //                 "4" — wrong. The compareRoute branch must subtract.
  //   - amountUsd-> nullable USD compare with null-sink semantics. If the
  //                 null handling regresses, no-data rows would float to the
  //                 top of the page.
  //   - duration -> nullable elapsed-time compare with null-sink semantics.
  //                 Pending rows (no deliveredTimestamp) must stay at the
  //                 bottom regardless of asc/desc.

  it("clicking Route header sorts numerically on (sourceChainId, destChainId), not lexically", () => {
    // Three sources whose numeric and lexical orderings diverge: 143, 8453,
    // and 42220. Numeric ASC = 143 < 8453 < 42220. Lexical ASC of the same
    // strings = "143" < "42220" < "8453" (because "4" precedes "8"). A
    // regression that swapped `compareRoute`'s numeric subtraction for
    // string compare would put 8453 LAST in ASC (where the test asserts it
    // should be middle), so this fixture catches the bug class Codex
    // flagged.
    const r1 = makeTransfer({
      id: "r1",
      sender: NEW_SENDER,
      sourceChainId: 143, // MONAD
      destChainId: 42220, // -> CELO
    });
    const r2 = makeTransfer({
      id: "r2",
      sender: MID_SENDER,
      sourceChainId: 42220, // CELO
      destChainId: 143, // -> MONAD
    });
    const r3 = makeTransfer({
      id: "r3",
      sender: OLD_SENDER,
      sourceChainId: 8453, // BASE — distinguishes numeric vs lexical
      destChainId: 42220, // -> CELO
    });
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [r2, r1, r3] }),
        count: ok({
          BridgeTransfer: [{ id: r1.id }, { id: r2.id }, { id: r3.id }],
        }),
      }),
    );
    renderJsdom();
    const routeBtn = findHeaderButton("Route");
    // First click after default = "Route" + DESC. Numeric DESC: 42220, 8453,
    // 143. Lexical DESC would put 8453 first (because "8" > "4"), so the
    // first-row assertion below catches the regression.
    act(() => {
      routeBtn.click();
    });
    let order = rowOrder();
    expect(order[0]).toContain(MID_SENDER); // sourceChainId=42220
    expect(order[1]).toContain(OLD_SENDER); // sourceChainId=8453
    expect(order[2]).toContain(NEW_SENDER); // sourceChainId=143
    // Click again -> ASC. Numeric ASC: 143, 8453, 42220. Lexical ASC would
    // put 8453 LAST (because "8" > "4"), so the middle-row assertion below
    // catches the regression.
    act(() => {
      routeBtn.click();
    });
    order = rowOrder();
    expect(order[0]).toContain(NEW_SENDER); // sourceChainId=143
    expect(order[1]).toContain(OLD_SENDER); // sourceChainId=8453
    expect(order[2]).toContain(MID_SENDER); // sourceChainId=42220
  });

  it("Amount column sort: null amountUsd rows sink to the bottom on ASC and DESC", () => {
    // Two rows have a USD value (USDm is 1:1 USD-pegged), one row has a null
    // amount (no USD value computable). Null rows must sink to the bottom in
    // both directions. (sourceChainId is set so SenderCell renders the
    // AddressLink stub the rowOrder() helper keys off.)
    const big = makeTransfer({
      id: "amt-big",
      sender: NEW_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      tokenSymbol: "USDm",
      amount: "10000000000000000000", // 10 USDm = $10
      tokenDecimals: 18,
    });
    const small = makeTransfer({
      id: "amt-small",
      sender: MID_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      tokenSymbol: "USDm",
      amount: "1000000000000000000", // 1 USDm = $1
      tokenDecimals: 18,
    });
    const noAmt = makeTransfer({
      id: "amt-null",
      sender: OLD_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      tokenSymbol: "USDm",
      amount: null,
    });
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [noAmt, big, small] }),
        count: ok({
          BridgeTransfer: [{ id: noAmt.id }, { id: big.id }, { id: small.id }],
        }),
      }),
    );
    renderJsdom();
    const amountBtn = findHeaderButton("Amount");
    // Click 1 -> Amount DESC: $10 > $1 > null
    act(() => {
      amountBtn.click();
    });
    let order = rowOrder();
    expect(order[0]).toContain(NEW_SENDER); // big
    expect(order[1]).toContain(MID_SENDER); // small
    expect(order[2]).toContain(OLD_SENDER); // null sinks
    // Click 2 -> Amount ASC: $1 < $10 < null  (null still sinks)
    act(() => {
      amountBtn.click();
    });
    order = rowOrder();
    expect(order[0]).toContain(MID_SENDER); // small
    expect(order[1]).toContain(NEW_SENDER); // big
    expect(order[2]).toContain(OLD_SENDER); // null still sinks (the contract!)
  });

  it("Duration column sort: pending (null duration) rows sink to the bottom on ASC and DESC", () => {
    // sourceChainId is set so SenderCell renders the AddressLink stub the
    // rowOrder() helper keys off.
    const fast = makeTransfer({
      id: "dur-fast",
      sender: NEW_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      status: "DELIVERED",
      sentTimestamp: "1000",
      deliveredTimestamp: "1010", // 10s
    });
    const slow = makeTransfer({
      id: "dur-slow",
      sender: MID_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      status: "DELIVERED",
      sentTimestamp: "1000",
      deliveredTimestamp: "2000", // 1000s
    });
    const pending = makeTransfer({
      id: "dur-pending",
      sender: OLD_SENDER,
      sourceChainId: CELO,
      destChainId: MONAD,
      status: "SENT",
      sentTimestamp: "1000",
      deliveredTimestamp: null, // no duration
    });
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [pending, fast, slow] }),
        count: ok({
          BridgeTransfer: [
            { id: pending.id },
            { id: fast.id },
            { id: slow.id },
          ],
        }),
      }),
    );
    renderJsdom();
    const durBtn = findHeaderButton("Duration");
    // Click 1 -> Duration DESC: 1000s > 10s > null
    act(() => {
      durBtn.click();
    });
    let order = rowOrder();
    expect(order[0]).toContain(MID_SENDER); // slow (1000s)
    expect(order[1]).toContain(NEW_SENDER); // fast (10s)
    expect(order[2]).toContain(OLD_SENDER); // pending sinks
    // Click 2 -> Duration ASC: 10s < 1000s < null  (null still sinks)
    act(() => {
      durBtn.click();
    });
    order = rowOrder();
    expect(order[0]).toContain(NEW_SENDER); // fast (10s)
    expect(order[1]).toContain(MID_SENDER); // slow (1000s)
    expect(order[2]).toContain(OLD_SENDER); // pending still sinks
  });
});

// ---------------------------------------------------------------------------
// 3. Pagination clamping
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — pagination and count state", () => {
  it("when URL says page=99 but total fits one page, the page sends offset=0 (clamped)", () => {
    const transfers = ALL_THREE_TRANSFERS;
    mockSearchParams = new URLSearchParams("page=99");
    // Capture the offset the page actually sends to the indexer. Without
    // this assertion the test would pass even if the page forwarded
    // offset=2450 (page 99 × 25), defeating the whole point of the
    // characterization.
    let observedOffset: number | null = null;
    mockUseBridgeGQL.mockImplementation(
      (query: string | null, vars?: { offset?: number }) => {
        if (query === BRIDGE_TRANSFERS_WINDOW) {
          observedOffset = vars?.offset ?? 0;
          return ok({
            BridgeTransfer: transfers.slice(
              observedOffset,
              observedOffset + 25,
            ),
          });
        }
        if (query === BRIDGE_TRANSFERS_COUNT)
          return ok({ BridgeTransfer: transfers.map((t) => ({ id: t.id })) });
        if (query === BRIDGE_PENDING_IDS) return ok({ BridgeTransfer: [] });
        if (query === BRIDGE_DAILY_SNAPSHOT)
          return ok({ BridgeDailySnapshot: [] });
        if (query === BRIDGE_TOP_BRIDGERS) return ok({ BridgeBridger: [] });
        if (query === BRIDGE_DELIVERED_RECENT)
          return ok({ BridgeTransfer: [] });
        return ok({});
      },
    );
    renderJsdom();
    expect(observedOffset).toBe(0);
    // List is non-empty.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    // Pager shows "3 total" (single page → no "page X of Y" suffix).
    expect(container.textContent).toContain("3 total");
    expect(container.textContent).not.toContain("page 99");
  });

  it("page=2 with 30 rows shows the second page (rows 26..30)", () => {
    const bulk = makeBulkTransfers(30);
    mockSearchParams = new URLSearchParams("page=2");
    // The page sends offset = (page-1)*25 = 25 to the indexer; in a mock
    // we just slice client-side and return the right slice on the
    // BRIDGE_TRANSFERS_WINDOW call.
    let observedOffset: number | null = null;
    mockUseBridgeGQL.mockImplementation(
      (query: string | null, vars?: { offset?: number }) => {
        if (query === BRIDGE_TRANSFERS_WINDOW) {
          observedOffset = vars?.offset ?? 0;
          return ok({
            BridgeTransfer: bulk.slice(observedOffset, observedOffset + 25),
          });
        }
        if (query === BRIDGE_TRANSFERS_COUNT)
          return ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) });
        if (query === BRIDGE_PENDING_IDS) return ok({ BridgeTransfer: [] });
        if (query === BRIDGE_DAILY_SNAPSHOT)
          return ok({ BridgeDailySnapshot: [] });
        if (query === BRIDGE_TOP_BRIDGERS) return ok({ BridgeBridger: [] });
        if (query === BRIDGE_DELIVERED_RECENT)
          return ok({ BridgeTransfer: [] });
        return ok({});
      },
    );
    renderJsdom();
    expect(observedOffset).toBe(25);
    // Pager: "30 total · page 2 of 2".
    expect(container.textContent).toContain("30 total");
    expect(container.textContent).toContain("page 2 of 2");
    // 5 rows on page 2.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  // ----- Outgoing setPage -> router.replace branch -----
  //
  // The previous tests in this block all exercise INCOMING `?page=` parsing
  // (URL → state → query offset). The other half of the URL-as-state
  // contract is the OUTGOING branch: clicking a Pagination button must call
  // `router.replace` with a URL whose `page` param matches the new page,
  // and `page=1` must be canonicalized as URL-cleared (no `?page=1` in the
  // history stack — that's why `setPage(1)` calls `params.delete("page")`).

  it("clicking 'Next' on Pagination calls router.replace with ?page=2", () => {
    const bulk = makeBulkTransfers(60); // 60 / 25 = 3 pages
    mockSearchParams = new URLSearchParams(); // page=1 (default)
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: bulk.slice(0, 25) }),
        count: ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) }),
      }),
    );
    renderJsdom();
    const nextBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Next page"]',
    );
    expect(nextBtn).toBeTruthy();
    expect(nextBtn?.disabled).toBe(false);
    act(() => {
      nextBtn!.click();
    });
    expect(mockReplace).toHaveBeenCalled();
    const lastUrl = mockReplace.mock.calls.at(-1)?.[0] as string;
    // URL-encoded `?page=2`. We don't constrain the leading `?` because the
    // page builds it as `?${params.toString()}`.
    expect(lastUrl).toContain("page=2");
  });

  it("clicking 'Last page' jumps to the final page", () => {
    const bulk = makeBulkTransfers(60); // 3 pages
    mockSearchParams = new URLSearchParams(); // page=1
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: bulk.slice(0, 25) }),
        count: ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) }),
      }),
    );
    renderJsdom();
    const lastBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Last page"]',
    );
    expect(lastBtn).toBeTruthy();
    act(() => {
      lastBtn!.click();
    });
    expect(mockReplace).toHaveBeenCalled();
    const url = mockReplace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("page=3");
  });

  it("clicking 'First page' from a non-first page canonicalizes to NO page param (page=1 is URL-cleared)", () => {
    // Start on page 2; expect First Page click to drop the `page=` param
    // entirely so the canonical URL for page 1 stays clean.
    const bulk = makeBulkTransfers(60); // 3 pages
    mockSearchParams = new URLSearchParams("page=2");
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: bulk.slice(25, 50) }),
        count: ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) }),
      }),
    );
    renderJsdom();
    const firstBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="First page"]',
    );
    expect(firstBtn).toBeTruthy();
    act(() => {
      firstBtn!.click();
    });
    expect(mockReplace).toHaveBeenCalled();
    const url = mockReplace.mock.calls.at(-1)?.[0] as string;
    // No `page=` token at all — page=1 must be the empty/default URL.
    expect(url).not.toContain("page=");
  });

  it("clicking 'Prev' from page=2 canonicalizes to NO page param (also page=1)", () => {
    const bulk = makeBulkTransfers(60); // 3 pages
    mockSearchParams = new URLSearchParams("page=2");
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: bulk.slice(25, 50) }),
        count: ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) }),
      }),
    );
    renderJsdom();
    const prevBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous page"]',
    );
    expect(prevBtn).toBeTruthy();
    act(() => {
      prevBtn!.click();
    });
    expect(mockReplace).toHaveBeenCalled();
    const url = mockReplace.mock.calls.at(-1)?.[0] as string;
    expect(url).not.toContain("page=");
  });

  it("page navigation preserves an existing ?status= filter param", () => {
    const bulk = makeBulkTransfers(60);
    mockSearchParams = new URLSearchParams("status=PENDING&page=1");
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: bulk.slice(0, 25) }),
        count: ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) }),
      }),
    );
    renderJsdom();
    const nextBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Next page"]',
    );
    act(() => {
      nextBtn!.click();
    });
    const url = mockReplace.mock.calls.at(-1)?.[0] as string;
    // status param survives, page advances.
    expect(url).toContain("status=PENDING");
    expect(url).toContain("page=2");
  });

  it("falls back to last-known total on count error (preserves the denominator)", () => {
    // Three renders: success → success → error. The page preserves the
    // last-successful total when the count query errors transiently. Real
    // users hit this via SWR's revalidation cadence (poll → success →
    // poll → transient error). Two prefacing successes are required to
    // populate state past initial-mount reset semantics.
    const bulk = makeBulkTransfers(50);

    function happyImpl(query: string | null) {
      if (query === BRIDGE_TRANSFERS_WINDOW)
        return ok({ BridgeTransfer: bulk.slice(0, 25) });
      if (query === BRIDGE_TRANSFERS_COUNT)
        return ok({ BridgeTransfer: bulk.map((t) => ({ id: t.id })) });
      if (query === BRIDGE_PENDING_IDS) return ok({ BridgeTransfer: [] });
      if (query === BRIDGE_DAILY_SNAPSHOT)
        return ok({ BridgeDailySnapshot: [] });
      if (query === BRIDGE_TOP_BRIDGERS) return ok({ BridgeBridger: [] });
      if (query === BRIDGE_DELIVERED_RECENT) return ok({ BridgeTransfer: [] });
      return ok({});
    }

    // Render 1 + render 2: count successful. After render 2 the ref is
    // populated with 50 AND the initial-mount effect reset has already
    // fired (and won't fire again unless statusKey changes).
    mockUseBridgeGQL.mockImplementation(happyImpl);
    renderJsdom();
    expect(container.textContent).toContain("50 total");
    act(() => {
      root.render(<BridgeFlowsPage />);
    });
    expect(container.textContent).toContain("50 total");

    // Render 3: count errors → fall back to preserved 50.
    mockUseBridgeGQL.mockImplementation((query: string | null) => {
      if (query === BRIDGE_TRANSFERS_COUNT)
        return failed<{ BridgeTransfer: Array<{ id: string }> }>(
          "transient count error",
        );
      return happyImpl(query);
    });
    act(() => {
      root.render(<BridgeFlowsPage />);
    });
    expect(container.textContent).toContain("50 total");
    expect(container.textContent).toContain("Total count degraded");
  });
});

// ---------------------------------------------------------------------------
// 4. Status filter
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — status filter", () => {
  it("URL ?status=PENDING marks the Pending pill as active and filters via statusIn", () => {
    mockSearchParams = new URLSearchParams("status=PENDING");
    let countVars: unknown = null;
    let transfersVars: unknown = null;
    mockUseBridgeGQL.mockImplementation(
      (query: string | null, vars?: unknown) => {
        if (query === BRIDGE_TRANSFERS_WINDOW) {
          transfersVars = vars;
          // Mock-side filter mirrors what the indexer would do.
          return ok({
            BridgeTransfer: ALL_THREE_TRANSFERS.filter(
              (t) => t.status === "PENDING",
            ),
          });
        }
        if (query === BRIDGE_TRANSFERS_COUNT) {
          countVars = vars;
          return ok({
            BridgeTransfer: ALL_THREE_TRANSFERS.filter(
              (t) => t.status === "PENDING",
            ).map((t) => ({ id: t.id })),
          });
        }
        if (query === BRIDGE_PENDING_IDS) return ok({ BridgeTransfer: [] });
        if (query === BRIDGE_DAILY_SNAPSHOT)
          return ok({ BridgeDailySnapshot: [] });
        if (query === BRIDGE_TOP_BRIDGERS) return ok({ BridgeBridger: [] });
        if (query === BRIDGE_DELIVERED_RECENT)
          return ok({ BridgeTransfer: [] });
        return ok({});
      },
    );
    renderJsdom();

    // The Pending radio pill is aria-checked.
    const pendingPill = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((b) => b.textContent?.trim() === "Pending");
    expect(pendingPill?.getAttribute("aria-checked")).toBe("true");

    // Total count tile reflects only Pending (1 of the 3 fixtures).
    expect(container.textContent).toContain("1 total");
    // Both queries got `statusIn = ["PENDING"]`.
    expect((countVars as { statusIn?: string[] }).statusIn).toEqual([
      "PENDING",
    ]);
    expect((transfersVars as { statusIn?: string[] }).statusIn).toEqual([
      "PENDING",
    ]);
    // Only the pending row renders in the table body.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("invalid status param falls back to All (selectedStatus=null)", () => {
    mockSearchParams = new URLSearchParams("status=BANANA");
    let observedStatusIn: string[] | null = null;
    mockUseBridgeGQL.mockImplementation(
      (query: string | null, vars?: unknown) => {
        if (query === BRIDGE_TRANSFERS_WINDOW) {
          observedStatusIn = (vars as { statusIn?: string[] }).statusIn ?? null;
          return ok({ BridgeTransfer: [] });
        }
        if (query === BRIDGE_TRANSFERS_COUNT) return ok({ BridgeTransfer: [] });
        if (query === BRIDGE_PENDING_IDS) return ok({ BridgeTransfer: [] });
        if (query === BRIDGE_DAILY_SNAPSHOT)
          return ok({ BridgeDailySnapshot: [] });
        if (query === BRIDGE_TOP_BRIDGERS) return ok({ BridgeBridger: [] });
        if (query === BRIDGE_DELIVERED_RECENT)
          return ok({ BridgeTransfer: [] });
        return ok({});
      },
    );
    renderJsdom();
    // statusIn should expand to the full ALL_BRIDGE_STATUSES set.
    expect(observedStatusIn).toEqual([
      "PENDING",
      "SENT",
      "ATTESTED",
      "QUEUED_INBOUND",
      "DELIVERED",
    ]);
    // All pill is selected.
    const allPill = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((b) => b.textContent?.trim() === "All");
    expect(allPill?.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking a status pill calls router.replace with the new status param + drops page", () => {
    mockSearchParams = new URLSearchParams("page=3");
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [] }),
      }),
    );
    renderJsdom();
    const sentPill = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((b) => b.textContent?.trim() === "Sent");
    expect(sentPill).toBeTruthy();
    act(() => {
      sentPill!.click();
    });
    expect(mockReplace).toHaveBeenCalled();
    const lastUrl = mockReplace.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain("status=SENT");
    expect(lastUrl).not.toContain("page=");
  });

  it("renders the 'no matches' empty state when the filter yields zero rows", () => {
    mockSearchParams = new URLSearchParams("status=DELIVERED");
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ transfers: ok({ BridgeTransfer: [] }) }),
    );
    renderJsdom();
    expect(container.textContent).toContain(
      "No bridge transfers match the selected status.",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Toast lifecycle
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — toast lifecycle (smoke)", () => {
  // Fakes timers so we can advance the 6 000 ms auto-dismiss without waiting.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Note: a previous "ToastPortal is mounted on the page" test was dropped
  // because it asserted on a stub-only wrapper — the real `ToastPortal`
  // returns `null` when toasts.length === 0, so the assertion would have
  // pinned stub behavior, not production. The captured-addToast suite below
  // exercises the real mount/dismiss flow.

  it("toasts stay empty until addToast fires (not auto-popping a phantom toast)", () => {
    renderJsdom();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });
});

// Module-level holder so the captured `addToast` is reachable from
// individual `it` blocks without requiring nested component definitions.
const capturedAddToastHolder: {
  fn:
    | ((message: string, type: "success" | "error", href?: string) => void)
    | null;
} = { fn: null };

function CapturingRedeemPill({
  addToast,
}: {
  addToast: (message: string, type: "success" | "error", href?: string) => void;
}) {
  capturedAddToastHolder.fn = addToast;
  return <span data-testid="redeem-pill">redeem</span>;
}

function CapturingToastPortal({
  toasts,
}: {
  toasts: Array<{ id: number; message: string }>;
}) {
  return (
    <div data-testid="toast-portal">
      {toasts.map((t) => (
        <div key={t.id} data-testid="toast" data-toast-id={t.id}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// Separate suite: capture addToast via the redeem pill mock to test the
// full toast lifecycle.
describe("BridgeFlowsPage — toast lifecycle (via captured addToast)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedAddToastHolder.fn = null;
    // Re-mock the redeem CTA module to capture addToast on each render.
    vi.doMock("@/components/bridge-redeem-cta", () => ({
      BridgeRedeemPill: CapturingRedeemPill,
      ToastPortal: CapturingToastPortal,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/components/bridge-redeem-cta");
    // Belt-and-braces: the next test's `await import("../page")` could
    // otherwise pick up a module compiled against this test's `doMock`.
    vi.resetModules();
  });

  it("two addToast calls show two toasts; both auto-dismiss after 6 000 ms each", async () => {
    const SECONDS_PER_DAY = 86_400;
    const nowSec = Math.floor(Date.now() / 1000);
    const stuck: BridgeTransfer = makeTransfer({
      id: "wormhole-stuck-2",
      providerMessageId: "stuck-2",
      status: "SENT",
      tokenSymbol: "USDm",
      sourceChainId: CELO,
      destChainId: MONAD,
      sender: "0xd2" + "2".repeat(38),
      recipient: "0xd2" + "3".repeat(38),
      amount: "1000000000000000000",
      sentTimestamp: String(nowSec - 2 * SECONDS_PER_DAY),
      sentTxHash:
        "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
      firstSeenAt: String(nowSec - 2 * SECONDS_PER_DAY),
    });
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [stuck] }),
        count: ok({ BridgeTransfer: [{ id: stuck.id }] }),
      }),
    );

    vi.resetModules();
    const Page = (await import("../page")).default;
    act(() => {
      root.render(<Page />);
    });
    expect(capturedAddToastHolder.fn).not.toBeNull();
    act(() => {
      capturedAddToastHolder.fn!("First", "success");
      capturedAddToastHolder.fn!("Second", "error");
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(2);
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("Second");

    // Both auto-dismiss at the 6 000 ms mark since they were enqueued in the
    // same batch.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("each toast has a unique id so two with the same message can both render", async () => {
    const SECONDS_PER_DAY = 86_400;
    const nowSec = Math.floor(Date.now() / 1000);
    const stuck: BridgeTransfer = makeTransfer({
      id: "wormhole-stuck-3",
      providerMessageId: "stuck-3",
      status: "SENT",
      tokenSymbol: "USDm",
      sourceChainId: CELO,
      destChainId: MONAD,
      sender: "0xd3" + "3".repeat(38),
      recipient: "0xd3" + "4".repeat(38),
      amount: "1000000000000000000",
      sentTimestamp: String(nowSec - 2 * SECONDS_PER_DAY),
      sentTxHash:
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      firstSeenAt: String(nowSec - 2 * SECONDS_PER_DAY),
    });
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [stuck] }),
        count: ok({ BridgeTransfer: [{ id: stuck.id }] }),
      }),
    );
    vi.resetModules();
    const Page = (await import("../page")).default;
    act(() => {
      root.render(<Page />);
    });
    act(() => {
      capturedAddToastHolder.fn!("Same message", "success");
      capturedAddToastHolder.fn!("Same message", "success");
    });
    const toasts = container.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(2);
    const ids = Array.from(toasts).map((t) => t.getAttribute("data-toast-id"));
    expect(new Set(ids).size).toBe(2);
  });

  it("addToast captured via redeem pill: toast appears, then auto-dismisses after 6 000 ms", async () => {
    // Build a STUCK transfer (canManuallyRedeemTransfer requires a sentTxHash
    // and a destChainId) so the redeem pill is rendered.
    // STUCK is derived: SENT + sentTimestamp older than 24h.
    const SECONDS_PER_DAY = 86_400;
    const nowSec = Math.floor(Date.now() / 1000);
    const stuck: BridgeTransfer = makeTransfer({
      id: "wormhole-stuck",
      providerMessageId: "stuck",
      status: "SENT",
      tokenSymbol: "USDm",
      sourceChainId: CELO,
      destChainId: MONAD,
      sender: "0xd0" + "0".repeat(38),
      recipient: "0xd0" + "1".repeat(38),
      amount: "1000000000000000000",
      sentTimestamp: String(nowSec - 2 * SECONDS_PER_DAY),
      sentTxHash:
        "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
      firstSeenAt: String(nowSec - 2 * SECONDS_PER_DAY),
    });

    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        transfers: ok({ BridgeTransfer: [stuck] }),
        count: ok({ BridgeTransfer: [{ id: stuck.id }] }),
      }),
    );

    // Re-import the module inside the doMock-scoped block so the new mock
    // is picked up.
    vi.resetModules();
    const Page = (await import("../page")).default;

    act(() => {
      root.render(<Page />);
    });

    // The redeem pill rendered → captured addToast.
    expect(capturedAddToastHolder.fn).not.toBeNull();

    // Fire a toast.
    act(() => {
      capturedAddToastHolder.fn!("Hello", "success");
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(1);
    expect(container.textContent).toContain("Hello");

    // Auto-dismiss at 6 000 ms.
    act(() => {
      vi.advanceTimersByTime(5_999);
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Route delivery tile
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — RouteDeliveryTile", () => {
  it("renders 'No delivered transfers yet' when delivered query is empty", () => {
    renderJsdom();
    expect(container.textContent).toContain("Avg Delivery Time by Route");
    expect(container.textContent).toContain("No delivered transfers yet");
  });

  it("renders an em-dash when the delivered query errors", () => {
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({
        delivered: failed<{
          BridgeTransfer: Array<{
            status: BridgeStatus;
            sentTimestamp: string | null;
            deliveredTimestamp: string | null;
            sourceChainId: number | null;
            destChainId: number | null;
          }>;
        }>("upstream broken"),
      }),
    );
    renderJsdom();
    // The route delivery tile section title should still appear, with an
    // em-dash (—) as the body.
    expect(container.textContent).toContain("Avg Delivery Time by Route");
    expect(container.textContent).toContain("—");
  });

  it("renders per-route averages when delivered transfers are returned", () => {
    const delivered = [
      // Route A: CELO → MONAD, two samples, avg 90s.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: "1060",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      {
        status: "DELIVERED" as const,
        sentTimestamp: "2000",
        deliveredTimestamp: "2120",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // Route B: MONAD → CELO, one sample, 30s.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "3000",
        deliveredTimestamp: "3030",
        sourceChainId: MONAD,
        destChainId: CELO,
      },
    ];
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ delivered: ok({ BridgeTransfer: delivered }) }),
    );
    renderJsdom();
    // formatDurationShort(90) = "1m 30s"; formatDurationShort(30) = "30s".
    // Sorted fastest-first → 30s first.
    expect(container.textContent).toMatch(/30s/);
    expect(container.textContent).toMatch(/1m 30s/);
    // last 100 delivered footnote.
    expect(container.textContent).toContain("last 100 delivered");
    // n=N counts on each row.
    expect(container.textContent).toContain("n=2");
    expect(container.textContent).toContain("n=1");
  });

  // ----- Exclusion logic for the route-stats average -----
  //
  // computeRouteAvgDeliverTimes() must ignore three classes of "garbled" rows
  // even though they reach the page from the BRIDGE_DELIVERED_RECENT query
  // slot:
  //
  //   1. Non-DELIVERED status (a SENT row with both timestamps set is the
  //      classic dest-first race / indexer-lag shape — must NOT pollute the
  //      avg even if both timestamps happen to be set first).
  //   2. Null sourceChainId or destChainId (no meaningful route key).
  //   3. Null sentTimestamp (delivery duration is unknowable).
  //
  // These tests pin the exclusion contract end-to-end through the page —
  // duplicating sibling lib-level coverage in `route-stats.test.ts` so a
  // future page-level wiring change can't quietly start summing partial rows.

  it("excludes non-DELIVERED rows even when both timestamps are present", () => {
    const delivered = [
      // 1 valid DELIVERED on Route A: 1000s
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: "2000",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // SENT but with deliveredTimestamp set (race / indexer lag). If the
      // exclusion is broken this row gets averaged in and changes the avg
      // to (1000 + 100) / 2 = 550s — would render as "9m 10s" instead of
      // "16m 40s".
      {
        status: "SENT" as const,
        sentTimestamp: "3000",
        deliveredTimestamp: "3100",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // ATTESTED with timestamps too — same exclusion shape.
      {
        status: "ATTESTED" as const,
        sentTimestamp: "4000",
        deliveredTimestamp: "4060",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
    ];
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ delivered: ok({ BridgeTransfer: delivered }) }),
    );
    renderJsdom();
    // n=1 (only the DELIVERED row contributed); the average is 1000s
    // = "16m 40s".
    expect(container.textContent).toContain("n=1");
    expect(container.textContent).toContain("16m 40s");
    // Belt-and-braces: the non-DELIVERED rows' shorter durations would have
    // produced "9m 10s" or "8m 50s" if averaged — neither must appear.
    expect(container.textContent).not.toContain("9m 10s");
    expect(container.textContent).not.toContain("8m 50s");
  });

  it("excludes rows with null sourceChainId or destChainId", () => {
    const delivered = [
      // 1 valid: 75s (formatDurationShort = "1m 15s") — picked so the
      // assertion on the formatted string can't false-positive on a generic
      // "1m" prefix.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: "1075",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // null source — must be dropped.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "2000",
        deliveredTimestamp: "3000",
        sourceChainId: null,
        destChainId: MONAD,
      },
      // null dest — must be dropped.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "4000",
        deliveredTimestamp: "4500",
        sourceChainId: CELO,
        destChainId: null,
      },
    ];
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ delivered: ok({ BridgeTransfer: delivered }) }),
    );
    renderJsdom();
    expect(container.textContent).toContain("n=1");
    expect(container.textContent).toContain("1m 15s");
    // Only one route line should render (the CELO->MONAD one). If the
    // null-chain rows leaked through, we'd see additional route averages.
    // We sanity-check via the n= count: only one "n=" appears.
    const matches = (container.textContent ?? "").match(/n=\d+/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("excludes DELIVERED rows with a null sentTimestamp (unknown duration)", () => {
    const delivered = [
      // valid: 30s
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: "1030",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // null sentTimestamp -> duration is null -> skipped.
      {
        status: "DELIVERED" as const,
        sentTimestamp: null,
        deliveredTimestamp: "5000",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // null deliveredTimestamp -> duration is null -> skipped.
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: null,
        sourceChainId: CELO,
        destChainId: MONAD,
      },
    ];
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ delivered: ok({ BridgeTransfer: delivered }) }),
    );
    renderJsdom();
    expect(container.textContent).toContain("n=1");
    expect(container.textContent).toContain("30s");
  });

  it("mixed shape (valid + every kind of excluded row) only counts the valid one", () => {
    // End-to-end smoke that combines all three exclusion classes — the brittle
    // shape that triggered the original bot finding.
    const delivered = [
      // ONE valid: 130s -> formatDurationShort = "2m 10s" (deliberately
      // picked off-the-minute so the assertion can't false-positive on
      // a leading "2m" substring).
      {
        status: "DELIVERED" as const,
        sentTimestamp: "1000",
        deliveredTimestamp: "1130",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // non-DELIVERED with both timestamps
      {
        status: "SENT" as const,
        sentTimestamp: "2000",
        deliveredTimestamp: "2050",
        sourceChainId: CELO,
        destChainId: MONAD,
      },
      // null source chain
      {
        status: "DELIVERED" as const,
        sentTimestamp: "3000",
        deliveredTimestamp: "3500",
        sourceChainId: null,
        destChainId: MONAD,
      },
      // null timestamps
      {
        status: "DELIVERED" as const,
        sentTimestamp: null,
        deliveredTimestamp: null,
        sourceChainId: CELO,
        destChainId: MONAD,
      },
    ];
    mockUseBridgeGQL.mockImplementation(
      bridgeImpl({ delivered: ok({ BridgeTransfer: delivered }) }),
    );
    renderJsdom();
    expect(container.textContent).toContain("n=1");
    expect(container.textContent).toContain("2m 10s");
  });
});

// ---------------------------------------------------------------------------
// 7. Hasura-not-configured friendly error path
// ---------------------------------------------------------------------------

describe("BridgeFlowsPage — Hasura-not-configured error path", () => {
  it("surfaces the friendly NEXT_PUBLIC_HASURA_URL error in an ErrorBox without crashing", () => {
    const friendly =
      "NEXT_PUBLIC_HASURA_URL is not configured. Set it in .env.local " +
      "(or Vercel env vars) to the indexer's Hasura endpoint.";
    // Mirror what useBridgeGQL returns when no client can be constructed:
    // every call yields { isLoading: false, error: <friendly Error> }.
    mockUseBridgeGQL.mockReturnValue({
      data: undefined,
      error: new Error(friendly),
      isLoading: false,
    });

    expect(() => renderJsdom()).not.toThrow();

    // ErrorBox role=alert; body contains the friendly string.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("NEXT_PUBLIC_HASURA_URL");

    // The transfers section degrades to "Unable to load transfers".
    expect(container.textContent).toContain(
      "Unable to load transfers — see error above.",
    );
  });
});

// Note: a previous "server render smoke" describe was dropped — it called
// `renderToStaticMarkup` from inside the jsdom-environment file, so
// `window`/`document` were available and the tests didn't exercise the
// real SSR path they claimed to cover. If PR-A2/A3 wants SSR coverage, it
// should land as a sibling `page.ssr.test.tsx` with `@vitest-environment
// node` so window-touching code in render actually fails the test.
