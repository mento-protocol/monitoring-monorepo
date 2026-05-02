/** @vitest-environment jsdom */
/**
 * Characterization tests for `BreachHistoryPanel`. These pin current
 * behavior so the upcoming extraction PRs (DurationFilter / BucketFilter
 * → A5; BreachTable / BreachRow / where-helpers → A6) can be verified
 * mechanical: the same inputs must keep producing the same output and
 * the same `useGQL` arguments.
 *
 * Test stack matches the codebase precedent for interactive React tests:
 * jsdom env + `react-dom/client` + `act` + native DOM events. We do NOT
 * pull in `@testing-library/react` because it isn't a dep here and
 * adding it would shift the test stack convention as a side-effect.
 *
 * Static-output tests (initial render, virtual-pool guard, FX-weekend
 * grace math, severity ratio) use `renderToStaticMarkup` because they
 * only inspect output and don't need the hydrated DOM.
 */

import React from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Pool,
  DeviationThresholdBreach,
  BreachEventCategory,
} from "@/lib/types";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// Hoisted mocks. Must be declared before the SUT import so vitest applies them
// at module-load time. Each test resets the recorded calls in beforeEach.
// ---------------------------------------------------------------------------

const mockUseGQL = vi.fn();

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (addr: string | null) => (addr ? `name:${addr.slice(-4)}` : "—"),
    getTags: (addr: string | null) => (addr ? ["tag-a", "tag-b"] : []),
    hasName: () => true,
    isCustom: () => false,
    getEntry: () => undefined,
  }),
}));

// `BreachHistoryPanel` itself doesn't call `useNetwork`, but the brief asked
// for the stub so we add it defensively in case a future descendant grows a
// hook usage (or a transitively-imported file does).
vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({ network: NETWORK }),
}));

// The chart import pulls plotly via `next/dynamic`; mock it out so tests don't
// need to load the bundle. Capture the full props so A6's chart-section
// extraction can't silently lose any prop on its way to the chart.
let capturedChartBreaches: DeviationThresholdBreach[] | null = null;
let capturedChartPool: unknown = null;
vi.mock("@/components/breach-history-chart", () => ({
  BreachHistoryChart: (props: {
    breaches: DeviationThresholdBreach[];
    pool?: unknown;
  }) => {
    capturedChartBreaches = props.breaches;
    capturedChartPool = props.pool ?? null;
    return <div data-testid="breach-chart" />;
  },
}));

// `TableSearch` debounces via `setTimeout` and re-renders when `value` prop
// changes; for characterization we replace it with a controlled input so
// the test can drive the panel's `onSearchChange` synchronously.
vi.mock("@/components/table-search", () => ({
  TableSearch: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel?: string;
  }) => (
    <input
      data-testid="table-search"
      aria-label={ariaLabel ?? "Search"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { BreachHistoryPanel } from "@/components/breach-history-panel";
import { ANCHOR_FRI_2100 } from "@/lib/weekend";
import { ENVIO_MAX_ROWS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Production pool IDs are `chainId-0x<token0addr><token1addr>` — both token
// addresses concatenated as 20-byte hex. Use a properly-shaped fixture so
// any future address-validation in the SUT doesn't pass spuriously.
const POOL_ID = `42220-0x${"a".repeat(40)}${"b".repeat(40)}`;
const STRATEGY_ADDR = "0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b";

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: { "0xt0": "USDm", "0xt1": "USDC" },
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
};

const BASE_POOL: Pool = {
  id: POOL_ID,
  chainId: 42220,
  token0: "0xt0",
  token1: "0xt1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  token0Decimals: 18,
  token1Decimals: 18,
  rebalanceThreshold: 100, // 1% — current mutable threshold
};

function makeBreach(
  overrides: Partial<DeviationThresholdBreach> = {},
): DeviationThresholdBreach {
  return {
    id: "b-default",
    chainId: 42220,
    poolId: POOL_ID,
    startedAt: "1700000000",
    startedAtBlock: "1",
    endedAt: "1700003600",
    endedAtBlock: "100",
    durationSeconds: "3600",
    criticalDurationSeconds: "0",
    entryPriceDifference: "150",
    entryRebalanceThreshold: 100,
    peakPriceDifference: "150",
    peakAt: "1700001000",
    peakAtBlock: "10",
    startedByEvent: "oracle_update" as BreachEventCategory,
    startedByTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab01",
    endedByEvent: "rebalance" as BreachEventCategory,
    endedByTxHash:
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab02",
    endedByStrategy: STRATEGY_ADDR,
    rebalanceCountDuring: 1,
    ...overrides,
  };
}

const ROW_SHORT = makeBreach({
  id: "b-short",
  startedAt: "1700000000",
  endedAt: "1700001800", // 30m
  durationSeconds: "1800",
  startedByEvent: "swap",
  endedByEvent: "rebalance",
  startedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab10",
  endedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab11",
});

const ROW_MID = makeBreach({
  id: "b-mid",
  startedAt: "1700100000",
  endedAt: "1700107200", // 2h
  durationSeconds: "7200",
  startedByEvent: "liquidity",
  endedByEvent: "rebalance",
  startedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab20",
  endedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab21",
});

const ROW_LONG = makeBreach({
  id: "b-long",
  startedAt: "1700200000",
  endedAt: "1700404000", // 56.67h ≈ 2.36d
  durationSeconds: "204000",
  startedByEvent: "oracle_update",
  endedByEvent: "rebalance",
  startedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab30",
  endedByTxHash:
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab31",
});

const ROW_OPEN = makeBreach({
  id: "b-open",
  startedAt: String(Math.floor(Date.now() / 1000) - 1800),
  endedAt: null,
  endedAtBlock: null,
  durationSeconds: null,
  criticalDurationSeconds: null,
  endedByEvent: null,
  endedByTxHash: null,
  endedByStrategy: null,
});

const ALL_ROWS = [ROW_SHORT, ROW_MID, ROW_LONG, ROW_OPEN];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Pin one return value per query string. The component fires three
 * concurrent useGQL calls — COUNT, PAGE, ALL — distinguished by the query
 * literal text. Routing returns by the leading word in the query keeps each
 * test's intent obvious.
 */
function setupGQL(routes: {
  page?: { data?: unknown; error?: unknown; isLoading?: boolean };
  count?: { data?: unknown; error?: unknown; isLoading?: boolean };
  all?: { data?: unknown; error?: unknown; isLoading?: boolean };
}) {
  mockUseGQL.mockImplementation((query: string | null) => {
    const q = (query ?? "").trim();
    if (q.startsWith("query PoolDeviationBreachesPage")) {
      return {
        isLoading: false,
        error: null,
        ...(routes.page ?? {}),
      };
    }
    if (q.startsWith("query PoolDeviationBreachesCount")) {
      return {
        isLoading: false,
        error: null,
        ...(routes.count ?? {}),
      };
    }
    if (q.startsWith("query PoolDeviationBreachesAll")) {
      return {
        isLoading: false,
        error: null,
        ...(routes.all ?? {}),
      };
    }
    return { data: undefined, error: null, isLoading: false };
  });
}

function pageVarsFromCalls(): Record<string, unknown> | null {
  // Walk from the end so we get the LATEST page call after a state change.
  for (let i = mockUseGQL.mock.calls.length - 1; i >= 0; i--) {
    const call = mockUseGQL.mock.calls[i];
    const q = String(call[0] ?? "").trim();
    if (q.startsWith("query PoolDeviationBreachesPage")) {
      return (call[1] as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

function countVarsFromCalls(): Record<string, unknown> | null {
  for (let i = mockUseGQL.mock.calls.length - 1; i >= 0; i--) {
    const call = mockUseGQL.mock.calls[i];
    const q = String(call[0] ?? "").trim();
    if (q.startsWith("query PoolDeviationBreachesCount")) {
      return (call[1] as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

function allVarsFromCalls(): Record<string, unknown> | null {
  for (let i = mockUseGQL.mock.calls.length - 1; i >= 0; i--) {
    const call = mockUseGQL.mock.calls[i];
    const q = String(call[0] ?? "").trim();
    if (q.startsWith("query PoolDeviationBreachesAll")) {
      return (call[1] as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

/**
 * The panel's stronger invariant is that every state change threads the
 * SAME `where` clause through COUNT (badge), PAGE (table), and ALL
 * (chart). Asserting fanout on COUNT alone leaves the chart/table free
 * to silently desync after A6's extraction. Pin all three to one JSON
 * shape so the relationship survives the refactor.
 */
function expectWhereFanout(): string {
  const countWhere = countVarsFromCalls()?.where;
  const pageWhere = pageVarsFromCalls()?.where;
  const allWhere = allVarsFromCalls()?.where;
  expect(countWhere).toBeDefined();
  expect(pageWhere).toBeDefined();
  expect(allWhere).toBeDefined();
  const countJson = JSON.stringify(countWhere);
  expect(JSON.stringify(pageWhere)).toBe(countJson);
  expect(JSON.stringify(allWhere)).toBe(countJson);
  return countJson;
}

// ---------------------------------------------------------------------------
// Test harness for interactive tests (clicks / typing)
// ---------------------------------------------------------------------------

function renderInteractive(
  props: Partial<{
    pool: Pool;
    network: Network;
    limit: number;
    search: string;
    onSearchChange: (v: string) => void;
  }> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSearchChange = props.onSearchChange ?? vi.fn();
  act(() => {
    root.render(
      <BreachHistoryPanel
        pool={props.pool ?? BASE_POOL}
        network={props.network ?? NETWORK}
        limit={props.limit ?? 25}
        search={props.search ?? ""}
        onSearchChange={onSearchChange}
      />,
    );
  });
  return { container, root, onSearchChange };
}

function findButton(
  container: HTMLElement,
  predicate: (text: string, btn: HTMLButtonElement) => boolean,
): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll("button"));
  const match = btns.find((b) =>
    predicate(b.textContent?.trim() ?? "", b as HTMLButtonElement),
  ) as HTMLButtonElement | undefined;
  if (!match)
    throw new Error(
      `No button matched predicate. Buttons present: ${btns
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  return match;
}

/**
 * Drive a controlled input the way React 19 expects: bypass the runtime's
 * cached descriptor by writing through the prototype setter, then dispatch a
 * bubbling `input` event so the React change handler fires synchronously.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Commit a draft input via the same delegated event React 19 listens for.
 * `blur` is intentionally NOT used — React 19 attaches its `onBlur` listener
 * to `focusout` (the bubbling counterpart), so a `blur` event would silently
 * not trigger the commit handler under jsdom.
 */
function commitOnBlur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** Commit via Enter — same effect as blur in this panel's DurationField. */
function commitOnEnter(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseGQL.mockReset();
  capturedChartBreaches = null;
  capturedChartPool = null;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// 1. Initial render (empty + populated)
// ---------------------------------------------------------------------------

describe("Initial render", () => {
  it("returns null for virtual pools (no fetch, no markup)", () => {
    setupGQL({});
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, source: "virtual_pool_factory" }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toBe("");
    // Virtual-pool guard runs BEFORE the inner panel mounts → no useGQL.
    expect(mockUseGQL).not.toHaveBeenCalled();
  });

  it("scopes all three queries (PAGE, COUNT, ALL) to the pool's id", () => {
    // Locks the pool-scope invariant so A6's chart-section / table extractions
    // can't silently desync the chart query (ALL) from the table queries
    // (PAGE/COUNT) — both must filter on the same pool.
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(pageVarsFromCalls()?.poolId).toBe(BASE_POOL.id);
    expect(countVarsFromCalls()?.poolId).toBe(BASE_POOL.id);
    expect(allVarsFromCalls()?.poolId).toBe(BASE_POOL.id);
  });

  it("shows the empty state when count=0 and page=[]", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain(
      "No deviation-threshold breaches recorded for this pool.",
    );
    // Total count rendered "0 breaches" (singular form for n=1, plural otherwise)
    expect(html).toContain("0 breaches");
  });

  it("renders one row per breach when data is non-empty", () => {
    setupGQL({
      count: {
        data: { DeviationThresholdBreach: ALL_ROWS.map((r) => ({ id: r.id })) },
      },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    // One <tr> per row plus one header → at least 5 <tr>s.
    const trCount = html.split("<tr").length - 1;
    expect(trCount).toBeGreaterThanOrEqual(5);
    // Column headers
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    expect(html).toContain("Past grace");
    expect(html).toContain("Peak");
    // Trigger column: at least one of our seeded labels surfaces
    expect(html).toContain("Swap");
    expect(html).toContain("Liquidity event");
  });

  it("shows the 'Loading…' placeholder while page is loading and rows are empty", () => {
    setupGQL({
      count: { data: undefined, isLoading: true },
      page: { data: undefined, isLoading: true },
      all: { data: undefined, isLoading: true },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Loading…");
  });

  it("shows the schema-lag banner when page query errors with 'field not found'", () => {
    setupGQL({
      count: { data: undefined, error: new Error("ignored") },
      page: {
        data: undefined,
        error: new Error("field 'DeviationThresholdBreach' not found"),
      },
      all: { data: undefined, error: new Error("ignored") },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("indexer rollout in progress");
  });

  it("shows the generic error banner on a non-schema page error", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: undefined, error: new Error("boom") },
      all: { data: undefined, error: new Error("boom") },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("load breach history");
  });

  it("forwards the chart-query rows to the BreachHistoryChart prop", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [ROW_SHORT] } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(capturedChartBreaches).not.toBeNull();
    expect(capturedChartBreaches!.map((r) => r.id)).toEqual(
      ALL_ROWS.map((r) => r.id),
    );
    // Pool prop forwards through to the chart so A6's chart-section
    // extraction can't silently drop it.
    expect(capturedChartPool).toMatchObject({ id: BASE_POOL.id });
  });
});

// ---------------------------------------------------------------------------
// 2. DurationField parse errors
// ---------------------------------------------------------------------------

describe("DurationField parse + commit", () => {
  beforeEach(() => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
  });

  it("commits a valid duration on blur (where var picks up the seconds)", () => {
    const { container } = renderInteractive();

    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    expect(minInput).toBeTruthy();
    expect(minInput.value).toBe("");

    setInputValue(minInput, "1h 30m");
    commitOnBlur(minInput);

    // Should NOT have applied the red-ring "invalid" class
    expect(minInput.className).not.toContain("border-red-500");

    // The COUNT (and PAGE, ALL) where clause should now embed the parsed seconds.
    const vars = countVarsFromCalls();
    expect(vars).toBeTruthy();
    const where = vars!.where as Record<string, unknown>;
    // 1h30m = 3600 + 1800 = 5400
    const json = JSON.stringify(where);
    expect(json).toContain("5400");
  });

  it("duration commit fans the SAME where clause to COUNT, PAGE, and ALL", () => {
    // Pin the cross-query invariant for a duration commit: the badge
    // (COUNT), table (PAGE), and chart (ALL) must all see the same
    // evolving `where` after a duration filter, otherwise the chart can
    // drift from the table during A6's extraction without any of the
    // `countVarsFromCalls`-only assertions catching it.
    const { container } = renderInteractive();
    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    setInputValue(minInput, "1h 30m");
    commitOnBlur(minInput);

    const where = expectWhereFanout();
    expect(where).toContain("5400");
  });

  it("flags a malformed duration without committing (where stays empty)", () => {
    const { container } = renderInteractive();

    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;

    setInputValue(minInput, "abc");
    commitOnBlur(minInput);

    expect(minInput.className).toContain("border-red-500");
    // No numeric duration filter should appear in `where`.
    const vars = countVarsFromCalls();
    expect(vars).toBeTruthy();
    expect(JSON.stringify(vars!.where)).not.toMatch(/_gte|_lte/);
  });

  it("Enter key commits like blur", () => {
    const { container } = renderInteractive();
    const maxInput = container.querySelector(
      'input[aria-label="Maximum breach duration"]',
    ) as HTMLInputElement;

    setInputValue(maxInput, "2h");
    commitOnEnter(maxInput);

    expect(maxInput.className).not.toContain("border-red-500");
    const json = JSON.stringify(countVarsFromCalls()!.where);
    expect(json).toContain("7200");
  });

  it("clears the invalid marker when the user starts typing again", () => {
    const { container } = renderInteractive();
    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    // Type junk and blur → invalid
    act(() => {
      setter.call(minInput, "blah");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      minInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(minInput.className).toContain("border-red-500");

    // Continue typing → marker clears immediately, no blur required
    act(() => {
      setter.call(minInput, "blahb");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(minInput.className).not.toContain("border-red-500");
  });

  it("empty draft commits null (clears the filter)", () => {
    const { container } = renderInteractive();
    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;

    // Commit a real value first.
    act(() => {
      setter.call(minInput, "30m");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      minInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(JSON.stringify(countVarsFromCalls()!.where)).toContain("1800");

    // Clear it.
    act(() => {
      setter.call(minInput, "");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      minInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    // Latest call no longer references the seconds value.
    const lastWhere = JSON.stringify(countVarsFromCalls()!.where);
    expect(lastWhere).not.toContain("1800");
  });

  it("rejects negative / zero durations as invalid", () => {
    const { container } = renderInteractive();
    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(minInput, "0");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      minInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(minInput.className).toContain("border-red-500");
  });
});

// ---------------------------------------------------------------------------
// 3. BucketFilter
// ---------------------------------------------------------------------------

describe("BucketFilter", () => {
  beforeEach(() => {
    setupGQL({
      count: {
        data: { DeviationThresholdBreach: ALL_ROWS.map((r) => ({ id: r.id })) },
      },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
  });

  it("default selection is 'All' (no duration clause in the where var)", () => {
    renderInteractive();
    const where = countVarsFromCalls()!.where as Record<string, unknown>;
    // "All" → empty bucket clause and no min/max → empty {} object
    expect(Object.keys(where)).toEqual([]);
  });

  it("selecting 'Over 1d' adds a `> 1d` clause", () => {
    const { container } = renderInteractive();
    const btn = findButton(container, (t) => t === "Over 1d");
    act(() => {
      btn.click();
    });
    const where = countVarsFromCalls()!.where as Record<string, unknown>;
    const json = JSON.stringify(where);
    expect(json).toContain("durationSeconds");
    expect(json).toContain('"_gt":"86400"');
  });

  it("bucket change fans the SAME where clause to COUNT, PAGE, and ALL", () => {
    // Pin the cross-query invariant for a bucket change. Without this,
    // an A6 refactor could drop the bucket clause from PAGE or ALL while
    // the badge (COUNT) stays correct — the table/chart would silently
    // diverge from the badge and every existing assertion stays green.
    const { container } = renderInteractive();
    act(() => {
      findButton(container, (t) => t === "Over 1d").click();
    });

    const where = expectWhereFanout();
    expect(where).toContain('"_gt":"86400"');
  });

  it("selecting '1h - 1d' adds both _gt:3600 and _lte:86400", () => {
    const { container } = renderInteractive();
    const btn = findButton(container, (t) => t === "1h – 1d");
    act(() => {
      btn.click();
    });
    const json = JSON.stringify(countVarsFromCalls()!.where);
    expect(json).toContain('"_gt":"3600"');
    expect(json).toContain('"_lte":"86400"');
  });

  it("selecting 'Ongoing' filters on `endedAt IS NULL`", () => {
    const { container } = renderInteractive();
    const btn = findButton(container, (t) => t === "Ongoing");
    act(() => {
      btn.click();
    });
    const where = countVarsFromCalls()!.where as Record<string, unknown>;
    expect(JSON.stringify(where)).toContain('"_is_null":true');
  });

  it("re-selecting 'All' restores the empty where clause", () => {
    const { container } = renderInteractive();
    act(() => {
      findButton(container, (t) => t === "Ongoing").click();
    });
    expect(JSON.stringify(countVarsFromCalls()!.where)).toContain(
      '"_is_null":true',
    );
    act(() => {
      findButton(container, (t) => t === "All").click();
    });
    const where = countVarsFromCalls()!.where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual([]);
  });

  it("aria-checked reflects the active bucket", () => {
    const { container } = renderInteractive();
    const allBtn = findButton(container, (t) => t === "All");
    expect(allBtn.getAttribute("aria-checked")).toBe("true");
    act(() => {
      findButton(container, (t) => t === "≤1h").click();
    });
    expect(
      findButton(container, (t) => t === "≤1h").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      findButton(container, (t) => t === "All").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("changing bucket resets pagination to page 1", () => {
    // Override the describe-level mock with a 60-row count so Pagination
    // renders Next/Prev controls (BucketFilter default count=4 rows would
    // collapse the controls to a single page).
    const ids = Array.from({ length: 60 }, (_, i) => ({ id: `b-${i}` }));
    setupGQL({
      count: { data: { DeviationThresholdBreach: ids } },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const { container } = renderInteractive();
    // Click "Next page" first to land on page 2.
    const nextBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Next page",
    );
    act(() => {
      nextBtn.click();
    });
    let pageVars = pageVarsFromCalls()!;
    expect(pageVars.offset).toBe(25);

    // Now switch bucket → offset must reset to 0.
    act(() => {
      findButton(container, (t) => t === "Over 1d").click();
    });
    pageVars = pageVarsFromCalls()!;
    expect(pageVars.offset).toBe(0);
  });

  it("committing a duration filter resets pagination to page 1", () => {
    // Same regression class as the bucket-reset test but for the
    // DurationField: A5's filter-component extraction must keep "filter
    // change clears the offset" wired through, otherwise a user who
    // navigated to page 2 and then narrowed the filter would land on a
    // sliced page that no longer exists for the new filter.
    const ids = Array.from({ length: 60 }, (_, i) => ({ id: `b-${i}` }));
    setupGQL({
      count: { data: { DeviationThresholdBreach: ids } },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const { container } = renderInteractive();
    const nextBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Next page",
    );
    act(() => {
      nextBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(25);

    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    setInputValue(minInput, "1h");
    commitOnBlur(minInput);
    expect(pageVarsFromCalls()!.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. BreachRow grace-period math (FX-pool weekend overlap)
// ---------------------------------------------------------------------------

describe("BreachRow weekend-aware duration", () => {
  // Pin Date.now to Mon 2024-01-08 00:00:00 UTC (1h after weekend reopen).
  const FIXED_NOW_SEC = ANCHOR_FRI_2100 + 180_000 + 3_600;
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_SEC * 1000));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("open breach spanning the weekend renders trading-seconds, not wall-clock", () => {
    // started 1h before Fri 21:00 UTC (one trading-hour before close).
    // wall-clock from start to now: 1h + 50h weekend + 1h = 52h.
    // trading-seconds: 1h + 1h = 2h.
    const startedAt = ANCHOR_FRI_2100 - 3_600;
    const openWeekendBreach = makeBreach({
      id: "b-weekend-open",
      startedAt: String(startedAt),
      endedAt: null,
      endedAtBlock: null,
      durationSeconds: null,
      criticalDurationSeconds: null,
      endedByEvent: null,
      endedByTxHash: null,
      endedByStrategy: null,
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [openWeekendBreach] } },
      all: { data: { DeviationThresholdBreach: [openWeekendBreach] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    // Trading-seconds = 7200 → "2h 0m"
    expect(html).toContain("2h 0m");
    // Wall-clock would be "2d 4h" (187200s) — must NOT appear
    expect(html).not.toContain("2d 4h");
    // "ongoing" suffix on open rows
    expect(html).toContain("ongoing");
  });

  it("closed breach uses the indexer-stored durationSeconds verbatim", () => {
    // Closed durationSeconds is already weekend-subtracted by the indexer;
    // the row formats it as-is. We pass 7200 explicitly and assert that's
    // what renders, regardless of the wall-clock between startedAt/endedAt.
    const closed = makeBreach({
      id: "b-closed",
      startedAt: String(ANCHOR_FRI_2100 - 3600),
      endedAt: String(ANCHOR_FRI_2100 + 180000 + 3600),
      durationSeconds: "7200",
      criticalDurationSeconds: "0",
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [closed] } },
      all: { data: { DeviationThresholdBreach: [closed] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("2h 0m");
    expect(html).not.toContain("ongoing");
  });
});

// ---------------------------------------------------------------------------
// 5. Critical-ratio scoring (entryRebalanceThreshold, NOT live pool threshold)
// ---------------------------------------------------------------------------

describe("BreachRow critical-ratio scoring", () => {
  // Pin time so the 1h grace check is deterministic.
  const FIXED_NOW_SEC = 1700_010_000;
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_SEC * 1000));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("uses entryRebalanceThreshold for the peak% column, not pool.rebalanceThreshold", () => {
    // peakPriceDifference / entryRebalanceThreshold = 200/100 = 2.0 → "200.0%"
    // If the row scored against pool.rebalanceThreshold=400 instead, it would
    // render "50.0%" — that's the regression we're characterizing against.
    const breach = makeBreach({
      id: "b-thresh-pin",
      startedAt: "1700000000",
      endedAt: "1700003600",
      durationSeconds: "3600",
      peakPriceDifference: "200",
      entryRebalanceThreshold: 100,
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [breach] } },
      all: { data: { DeviationThresholdBreach: [breach] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, rebalanceThreshold: 400 }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("200.0%");
    expect(html).not.toContain("50.0%");
  });

  it("falls back to pool.rebalanceThreshold when entryRebalanceThreshold is missing", () => {
    // Resync window: no entry threshold yet. peakPriceDifference / pool.rebalanceThreshold
    // = 100 / 100 = 1.0 → "100.0%"
    const breach = makeBreach({
      id: "b-thresh-fallback",
      peakPriceDifference: "100",
      entryRebalanceThreshold: undefined,
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [breach] } },
      all: { data: { DeviationThresholdBreach: [breach] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, rebalanceThreshold: 100 }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("100.0%");
  });

  it("renders past-grace duration in red when peak crossed the 1.05x critical ratio (closed row)", () => {
    // peak/entryRebalanceThreshold = 200/100 = 2.0 > 1.05 critical → red.
    // pool.rebalanceThreshold deliberately set to 400 (peak/pool = 0.5,
    // sub-critical) so a regression that scored against the live mutable
    // pool threshold instead of the per-event entry threshold would render
    // grey em-dash and fail this test.
    const critBreach = makeBreach({
      id: "b-crit",
      durationSeconds: "3600",
      criticalDurationSeconds: "60",
      peakPriceDifference: "200",
      entryRebalanceThreshold: 100,
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [critBreach] } },
      all: { data: { DeviationThresholdBreach: [critBreach] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, rebalanceThreshold: 400 }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("text-red-400");
    // Past-grace cell content: 60s formatted as "1m"
    expect(html).toContain("1m");
  });

  it("renders em-dash + grey when peak stayed under 1.05x (closed row)", () => {
    // peak/entryRebalanceThreshold = 100/100 = 1.0 ≤ 1.05 critical → grey.
    // pool.rebalanceThreshold deliberately set to 50 (peak/pool = 2.0,
    // super-critical) so a regression that scored against the live mutable
    // pool threshold instead of the per-event entry threshold would render
    // red and fail this test.
    const subCritBreach = makeBreach({
      id: "b-sub-crit",
      durationSeconds: "7200",
      criticalDurationSeconds: "0",
      peakPriceDifference: "100",
      entryRebalanceThreshold: 100,
    });
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "x" }] } },
      page: { data: { DeviationThresholdBreach: [subCritBreach] } },
      all: { data: { DeviationThresholdBreach: [subCritBreach] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, rebalanceThreshold: 50 }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    // Past-grace cell shows em-dash
    expect(html).toContain("—");
    // Grey class for non-critical
    expect(html).toContain("text-slate-500");
  });
});

// ---------------------------------------------------------------------------
// 6. Sort + pagination
// ---------------------------------------------------------------------------

describe("Sort + Pagination", () => {
  beforeEach(() => {
    // Build a 3-page result set (count=60, limit=25) so Next is enabled.
    const ids = Array.from({ length: 60 }, (_, i) => ({ id: `b-${i}` }));
    setupGQL({
      count: { data: { DeviationThresholdBreach: ids } },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
  });

  it("default orderBy is startedAt desc + secondary id asc", () => {
    renderInteractive();
    const vars = pageVarsFromCalls()!;
    const orderBy = vars.orderBy as Array<Record<string, string>>;
    expect(orderBy[0]).toEqual({ startedAt: "desc" });
    // Tail tie-breakers: 'id: asc' is appended (no secondary distinct)
    expect(orderBy[orderBy.length - 1]).toEqual({ id: "asc" });
  });

  it("clicking a column header sets that column as primary sort, desc default", () => {
    const { container } = renderInteractive();
    // SortableTh wraps a button whose text is the header label.
    const peakBtn = findButton(container, (t) => t.startsWith("Peak"));
    act(() => {
      peakBtn.click();
    });
    const orderBy = pageVarsFromCalls()!.orderBy as Array<
      Record<string, string>
    >;
    expect(orderBy[0]).toEqual({ peakPriceDifference: "desc" });
  });

  it("clicking the same column header twice toggles direction asc → desc → asc", () => {
    const { container } = renderInteractive();
    const peakBtn = findButton(container, (t) => t.startsWith("Peak"));

    act(() => {
      peakBtn.click(); // first click: desc
    });
    let orderBy = pageVarsFromCalls()!.orderBy as Array<Record<string, string>>;
    expect(orderBy[0]).toEqual({ peakPriceDifference: "desc" });

    act(() => {
      peakBtn.click(); // toggle to asc
    });
    orderBy = pageVarsFromCalls()!.orderBy as Array<Record<string, string>>;
    expect(orderBy[0]).toEqual({ peakPriceDifference: "asc" });

    act(() => {
      peakBtn.click(); // toggle back to desc
    });
    orderBy = pageVarsFromCalls()!.orderBy as Array<Record<string, string>>;
    expect(orderBy[0]).toEqual({ peakPriceDifference: "desc" });
  });

  it("aria-sort on each sortable header reflects the active sort state", () => {
    // The query-side orderBy is already pinned by the tests above, but
    // `aria-sort` is the screen-reader-visible state and there are no
    // other `aria-sort` assertions in the dashboard test suite. A6's
    // table extraction could swap the markup and silently drop the
    // attribute while keeping `orderBy` correct — pin the SR contract
    // for every sortable column so that regression fails loudly here.
    const { container } = renderInteractive();

    // Resolve the parent <th> for a SortableTh button. SortableTh wraps
    // the click target in `<th><button>label</button></th>`, so walk up
    // from the matched button.
    const thFor = (predicate: (t: string) => boolean): HTMLTableCellElement => {
      const btn = findButton(container, predicate);
      const th = btn.closest("th");
      if (!th) throw new Error("Sortable button has no parent <th>");
      return th as HTMLTableCellElement;
    };
    const sortFor = (predicate: (t: string) => boolean): string | null =>
      thFor(predicate).getAttribute("aria-sort");

    // Default: Started is the active sort (desc). Others are "none".
    expect(sortFor((t) => t.startsWith("Started"))).toBe("descending");
    expect(sortFor((t) => t.startsWith("Duration"))).toBe("none");
    expect(sortFor((t) => t.startsWith("Past grace"))).toBe("none");
    expect(sortFor((t) => t.startsWith("Peak"))).toBe("none");

    // Click Duration → flips to descending; Started becomes "none".
    act(() => {
      findButton(container, (t) => t.startsWith("Duration")).click();
    });
    expect(sortFor((t) => t.startsWith("Duration"))).toBe("descending");
    expect(sortFor((t) => t.startsWith("Started"))).toBe("none");

    // Click Duration again → toggles to ascending.
    act(() => {
      findButton(container, (t) => t.startsWith("Duration")).click();
    });
    expect(sortFor((t) => t.startsWith("Duration"))).toBe("ascending");

    // Click Past grace → that becomes the active descending sort.
    act(() => {
      findButton(container, (t) => t.startsWith("Past grace")).click();
    });
    expect(sortFor((t) => t.startsWith("Past grace"))).toBe("descending");
    expect(sortFor((t) => t.startsWith("Duration"))).toBe("none");

    // Click Peak → same dance, with Past grace going back to "none".
    act(() => {
      findButton(container, (t) => t.startsWith("Peak")).click();
    });
    expect(sortFor((t) => t.startsWith("Peak"))).toBe("descending");
    expect(sortFor((t) => t.startsWith("Past grace"))).toBe("none");
  });

  it("Next button advances offset by limit", () => {
    const { container } = renderInteractive({ limit: 25 });
    expect(pageVarsFromCalls()!.offset).toBe(0);

    const nextBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Next page",
    );
    act(() => {
      nextBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(25);

    act(() => {
      nextBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(50);
  });

  it("First/Last buttons jump to page 1 and lastPage", () => {
    const { container } = renderInteractive({ limit: 25 });
    const lastBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Last page",
    );
    act(() => {
      lastBtn.click();
    });
    // total=60, limit=25 → totalPages=3 → offset = (3-1)*25 = 50
    expect(pageVarsFromCalls()!.offset).toBe(50);

    const firstBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "First page",
    );
    act(() => {
      firstBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(0);
  });

  it("clicking a sort header resets pagination to page 1", () => {
    const { container } = renderInteractive({ limit: 25 });
    const nextBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Next page",
    );
    act(() => {
      nextBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(25);

    const peakBtn = findButton(container, (t) => t.startsWith("Peak"));
    act(() => {
      peakBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(0);
  });

  it("limit prop is forwarded as $limit to the page query", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    renderInteractive({ limit: 10 });
    expect(pageVarsFromCalls()!.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 7. Search + filter composition
// ---------------------------------------------------------------------------

describe("Search + filter composition", () => {
  it("client-side search narrows visible rows by trigger label", () => {
    setupGQL({
      count: {
        data: { DeviationThresholdBreach: ALL_ROWS.map((r) => ({ id: r.id })) },
      },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        // Search for "swap" — should keep ROW_SHORT (startedByEvent=swap), drop the rest.
        search="swap"
        onSearchChange={() => {}}
      />,
    );
    // The "swap" row's tx hash should appear, the others' should not.
    expect(html).toContain(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab10",
    );
    expect(html).not.toContain(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab20",
    );
    expect(html).not.toContain(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab30",
    );
  });

  it("renders the 'no breaches on this page match your search' fallback when search filters everything", () => {
    setupGQL({
      count: {
        data: { DeviationThresholdBreach: ALL_ROWS.map((r) => ({ id: r.id })) },
      },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search="zzz-no-match"
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("No breaches on this page match your search.");
  });

  it("bucket + min duration compose into a single _and clause", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const { container } = renderInteractive();

    // Pick a bucket
    act(() => {
      findButton(container, (t) => t === "Over 1d").click();
    });

    // Type a min duration
    const minInput = container.querySelector(
      'input[aria-label="Minimum breach duration"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(minInput, "7d");
      minInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      minInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    const where = countVarsFromCalls()!.where as Record<string, unknown>;
    const json = JSON.stringify(where);
    // The bucket wins as the first AND term, with > 1d.
    expect(json).toContain('"_gt":"86400"');
    // The minSeconds adds a second AND term — 7d = 604800.
    expect(json).toContain('"_gte":"604800"');
    // The OR-with-null keeps in-flight rows visible regardless of min.
    expect(json).toContain('"_is_null":true');
    // Both terms present → composed under _and
    expect(json).toContain("_and");
  });

  it("search input commits via the panel's onSearchChange", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const onSearchChange = vi.fn();
    const { container } = renderInteractive({ onSearchChange });
    const search = container.querySelector(
      '[data-testid="table-search"]',
    ) as HTMLInputElement;
    expect(search).toBeTruthy();

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(search, "rebalance");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onSearchChange).toHaveBeenCalledWith("rebalance");
  });

  it("search input change resets pagination to page 1", () => {
    // Same regression class as the bucket / duration / sort reset tests
    // but for the search box. Without this, an A6 extraction can drop
    // `setRawPage(1)` from `handleSearchChange` and the user typing into
    // the search box on page 2 lands on a stale offset slice for the new
    // (narrowed) row set. Build a 60-row count so Pagination renders Next.
    const ids = Array.from({ length: 60 }, (_, i) => ({ id: `b-${i}` }));
    setupGQL({
      count: { data: { DeviationThresholdBreach: ids } },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const { container } = renderInteractive({ limit: 25 });

    // Land on page 2.
    const nextBtn = findButton(
      container,
      (_t, b) => b.getAttribute("aria-label") === "Next page",
    );
    act(() => {
      nextBtn.click();
    });
    expect(pageVarsFromCalls()!.offset).toBe(25);

    // Type into the search input → page must reset to 0.
    const search = container.querySelector(
      '[data-testid="table-search"]',
    ) as HTMLInputElement;
    setInputValue(search, "rebalance");
    expect(pageVarsFromCalls()!.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Virtual-pool guard
// ---------------------------------------------------------------------------

describe("Virtual-pool guard", () => {
  it("'virtual_pool_factory' is treated as virtual → returns null", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, source: "virtual_pool_factory" }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  it("any pool with `source` containing 'virtual' is virtual", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, source: "some_virtual_thing" }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  it("non-virtual sources render the panel as usual", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [] } },
      page: { data: { DeviationThresholdBreach: [] } },
      all: { data: { DeviationThresholdBreach: [] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Breach History");
  });

  it("virtual-pool guard skips all useGQL fetches", () => {
    setupGQL({});
    renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, source: "virtual_pool_factory" }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(mockUseGQL).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge cases that came up during investigation — anchor them too so the
// extraction PRs can't quietly regress.
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("count cap banner appears when raw total ≥ ENVIO_MAX_ROWS", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => ({ id: `b-${i}` }));
    setupGQL({
      count: { data: { DeviationThresholdBreach: ids } },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    // Use the same formatter the component uses so this stays
    // locale-agnostic — `toLocaleString()` returns "1,000" in en-US but
    // "1.000" / "1 000" elsewhere; hard-coding the comma form would
    // make this test flake under non-en-US Vitest workers.
    expect(html).toContain(`${ENVIO_MAX_ROWS.toLocaleString()}+ breaches`);
    expect(html).toContain("t visible");
  });

  it("count failure does NOT blank rows; pagination errBox renders", () => {
    setupGQL({
      count: { data: undefined, error: new Error("count blew up") },
      page: { data: { DeviationThresholdBreach: ALL_ROWS } },
      all: { data: { DeviationThresholdBreach: ALL_ROWS } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Pagination unavailable");
    // Rows still rendered
    expect(html).toContain("Swap"); // ROW_SHORT trigger label
    // Title shows the "+ on this page" fallback
    expect(html).toContain("on this page");
  });

  it("virtual pool guard runs before any GQL fetch", () => {
    setupGQL({});
    renderToStaticMarkup(
      <BreachHistoryPanel
        pool={{ ...BASE_POOL, source: "virtual_pool_factory" }}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(mockUseGQL).toHaveBeenCalledTimes(0);
  });

  it("singular 'breach' (not 'breaches') for n=1", () => {
    setupGQL({
      count: { data: { DeviationThresholdBreach: [{ id: "b-only" }] } },
      page: { data: { DeviationThresholdBreach: [ROW_SHORT] } },
      all: { data: { DeviationThresholdBreach: [ROW_SHORT] } },
    });
    const html = renderToStaticMarkup(
      <BreachHistoryPanel
        pool={BASE_POOL}
        network={NETWORK}
        limit={25}
        search=""
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("1 breach");
  });
});
