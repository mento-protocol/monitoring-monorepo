/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * axe-core accessibility checks for the dashboard's interactive controls.
 *
 * Targets:
 *
 * 1. `LimitSelect` — native `<select>` paired with a `<label htmlFor>`. axe's
 *    `label` rule catches a missing label or a broken `htmlFor`/`id` pairing.
 *
 * 2. `BridgeStatusFilter` — `role="radiogroup"` with each pill a
 *    `role="radio"` and an `aria-checked` value derived from `selected`.
 *    Tests the WAI-ARIA radio button pattern: exactly one radio
 *    `aria-checked="true"` per group, all others `"false"`. axe's
 *    `aria-allowed-role` / `aria-required-attr` rules cover the role
 *    contract. We also assert the count of checked radios for both the
 *    default ("All") and a status-active state, since axe alone doesn't
 *    flag the "two radios checked" anti-pattern.
 *
 * 3. `BucketFilter` — `role="radiogroup"` with duration filter pills that
 *    share the same roving-tabindex helper as `BridgeStatusFilter`.
 *
 * 4. `PoolTablist` — the real production component (extracted from
 *    `pool/[poolId]/page.tsx` so the test mounts the actual JSX, not a
 *    re-implementation). Pins the `role="tablist"` + `role="tab"` +
 *    `aria-selected` + `aria-controls` contract. If the page-side
 *    rendering drops `role="tablist"` or breaks `aria-controls`, this
 *    test now catches it (Cursor finding on PR #342).
 *
 * 5. `CdpTroveTable` — the real CDP detail table view switcher. Pins the
 *    `Open` / `History` pair as tabs, not toggle buttons, so screen readers
 *    announce the selected table view accurately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import { LimitSelect } from "@/components/controls";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import {
  BucketFilter,
  type DurationBucket,
} from "@/components/breach-history/bucket-filter";
import { PoolTablist } from "@/app/pool/[poolId]/_components/pool-tablist";
import { TABS, type Tab } from "@/app/pool/[poolId]/_lib/constants";
import { CdpTroveTable } from "@/app/cdps/[symbol]/_components/cdp-trove-table";
import type { CdpCollateral } from "@/app/cdps/_lib/types";
import type { BridgeStatus } from "@/lib/types";

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function render(element: React.ReactElement) {
  act(() => {
    root.render(element);
  });
}

// ---------------------------------------------------------------------------
// LimitSelect — labelled native select
// ---------------------------------------------------------------------------

describe("LimitSelect a11y", () => {
  it("native <select> is labelled and has no axe violations", async () => {
    render(
      <LimitSelect id="tab-limit-test" value={50} onChange={() => undefined} />,
    );
    const select = container.querySelector("select");
    const label = container.querySelector('label[for="tab-limit-test"]');
    expect(select).not.toBeNull();
    expect(label).not.toBeNull();
    expect(select?.id).toBe("tab-limit-test");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BridgeStatusFilter — radiogroup contract
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: readonly BridgeStatus[] = [
  "PENDING",
  "SENT",
  "ATTESTED",
  "DELIVERED",
];

describe("BridgeStatusFilter a11y", () => {
  it("radiogroup with 'All' selected: exactly one aria-checked=true and zero violations", async () => {
    render(
      <BridgeStatusFilter
        options={STATUS_OPTIONS}
        selected={null}
        onChange={() => undefined}
      />,
    );
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe(
      "Filter transfers by status",
    );
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(STATUS_OPTIONS.length + 1); // +1 for "All"
    const checked = Array.from(radios).filter(
      (r) => r.getAttribute("aria-checked") === "true",
    );
    expect(checked).toHaveLength(1);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("radiogroup with a specific status selected: still exactly one aria-checked=true", async () => {
    render(
      <BridgeStatusFilter
        options={STATUS_OPTIONS}
        selected="DELIVERED"
        onChange={() => undefined}
      />,
    );
    const radios = container.querySelectorAll('[role="radio"]');
    const checked = Array.from(radios).filter(
      (r) => r.getAttribute("aria-checked") === "true",
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain("Delivered");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  // WAI-ARIA radiogroup keyboard contract — single tab stop with arrow
  // keys moving focus AND selection together (radiogroup convention).
  // See https://www.w3.org/WAI/ARIA/apg/patterns/radio/.
  describe("BridgeStatusFilter: keyboard contract", () => {
    function radios(): HTMLButtonElement[] {
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      );
    }

    function pillByLabel(label: string): HTMLButtonElement {
      const match = radios().find((r) => r.textContent?.trim() === label);
      if (!match) throw new Error(`No radio pill with label ${label}`);
      return match;
    }

    function dispatch(el: HTMLElement, key: string) {
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }

    it("single tab stop: exactly one tabIndex=0 (selected pill); the rest are tabIndex=-1", () => {
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected="ATTESTED"
          onChange={() => undefined}
        />,
      );
      const tabbable = radios().filter((r) => r.tabIndex === 0);
      const untabbable = radios().filter((r) => r.tabIndex === -1);
      expect(tabbable).toHaveLength(1);
      expect(untabbable).toHaveLength(STATUS_OPTIONS.length); // (N+1) - 1
      expect(tabbable[0]!.textContent).toContain("Attested");
    });

    it("when selected=null, the 'All' pill holds the single tab stop", () => {
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={() => undefined}
        />,
      );
      const tabbable = radios().filter((r) => r.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]!.textContent?.trim()).toBe("All");
    });

    it("ArrowRight moves focus to the next pill AND fires onChange with that value", () => {
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={onChange}
        />,
      );
      const all = pillByLabel("All");
      all.focus();
      dispatch(all, "ArrowRight");
      // Index 1 → first status option ("PENDING" → "Pending")
      expect(document.activeElement).toBe(pillByLabel("Pending"));
      expect(onChange).toHaveBeenCalledWith("PENDING");
    });

    it("ArrowLeft from 'All' wraps focus AND selection to the last pill", () => {
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={onChange}
        />,
      );
      const all = pillByLabel("All");
      all.focus();
      dispatch(all, "ArrowLeft");
      const last = STATUS_OPTIONS[STATUS_OPTIONS.length - 1];
      expect(onChange).toHaveBeenCalledWith(last);
      // Last pill in STATUS_OPTIONS is "DELIVERED" → label "Delivered"
      expect(document.activeElement).toBe(pillByLabel("Delivered"));
    });

    it("ArrowDown behaves like ArrowRight (radiogroup convention)", () => {
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={onChange}
        />,
      );
      const all = pillByLabel("All");
      all.focus();
      dispatch(all, "ArrowDown");
      expect(onChange).toHaveBeenCalledWith("PENDING");
      expect(document.activeElement).toBe(pillByLabel("Pending"));
    });

    it("ArrowUp behaves like ArrowLeft (radiogroup convention)", () => {
      // Render with a non-null `selected` so ArrowUp (which moves to a
      // different value) actually triggers `onChange`. Controlled-component
      // semantics: `onChange` only fires when the new value differs from
      // the current `selected` prop.
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected="PENDING"
          onChange={onChange}
        />,
      );
      const pending = pillByLabel("Pending");
      pending.focus();
      dispatch(pending, "ArrowUp");
      expect(onChange).toHaveBeenCalledWith(null);
      expect(document.activeElement).toBe(pillByLabel("All"));
    });

    it("Home jumps focus + selection to the first pill ('All')", () => {
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected="DELIVERED"
          onChange={onChange}
        />,
      );
      const last = pillByLabel("Delivered");
      last.focus();
      dispatch(last, "Home");
      expect(document.activeElement).toBe(pillByLabel("All"));
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it("End jumps focus + selection to the last pill", () => {
      const onChange = vi.fn();
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={onChange}
        />,
      );
      const all = pillByLabel("All");
      all.focus();
      dispatch(all, "End");
      const last = STATUS_OPTIONS[STATUS_OPTIONS.length - 1];
      expect(onChange).toHaveBeenCalledWith(last);
      expect(document.activeElement).toBe(pillByLabel("Delivered"));
    });

    it("roving tabindex: arrow-key focus moves the single tab stop to the focused pill", () => {
      // Codex finding on PR #350: under URL-backed `selected`,
      // tying `tabIndex={0}` to the selected pill leaves a stale tab
      // stop while focus is on the newly arrived pill, breaking the
      // single-tab-stop contract for Tab/Shift+Tab navigation. The
      // local roving tabindex must follow focus.
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected={null}
          onChange={() => undefined}
        />,
      );
      // Initial: "All" holds the tab stop.
      expect(pillByLabel("All").tabIndex).toBe(0);
      // ArrowRight from "All" → focus moves to "Pending"; tab stop moves with it.
      const all = pillByLabel("All");
      all.focus();
      dispatch(all, "ArrowRight");
      expect(document.activeElement).toBe(pillByLabel("Pending"));
      expect(pillByLabel("Pending").tabIndex).toBe(0);
      // Tab stop is now exclusively on "Pending"; "All" and the rest are -1.
      const tabbable = radios().filter((r) => r.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]!.textContent?.trim()).toBe("Pending");
    });

    it("axe still passes after the keyboard contract is in place", async () => {
      render(
        <BridgeStatusFilter
          options={STATUS_OPTIONS}
          selected="SENT"
          onChange={() => undefined}
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// BucketFilter — radiogroup contract
// ---------------------------------------------------------------------------

describe("BucketFilter a11y", () => {
  function renderBucketFilterHarness(
    initial: DurationBucket = "all",
    onChange: (next: DurationBucket) => void = () => undefined,
  ) {
    function BucketFilterHarness() {
      const [selected, setSelected] = useState<DurationBucket>(initial);
      return (
        <BucketFilter
          selected={selected}
          onChange={(next) => {
            onChange(next);
            setSelected(next);
          }}
        />
      );
    }

    render(<BucketFilterHarness />);
  }

  function radios(): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
  }

  function pillByLabel(label: string): HTMLButtonElement {
    const match = radios().find((r) => r.textContent?.trim() === label);
    if (!match) throw new Error(`No bucket pill with label ${label}`);
    return match;
  }

  function dispatch(el: HTMLElement, key: string) {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  it("single tab stop: exactly one tabIndex=0 (selected bucket); the rest are tabIndex=-1", () => {
    renderBucketFilterHarness("long");
    const tabbable = radios().filter((r) => r.tabIndex === 0);
    const untabbable = radios().filter((r) => r.tabIndex === -1);
    expect(tabbable).toHaveLength(1);
    expect(untabbable).toHaveLength(4);
    expect(tabbable[0]!.textContent?.trim()).toBe("Over 1d");
  });

  it("ArrowRight moves focus + selection to the next bucket", () => {
    const onChange = vi.fn();
    renderBucketFilterHarness("all", onChange);
    const all = pillByLabel("All");
    all.focus();
    dispatch(all, "ArrowRight");
    expect(document.activeElement).toBe(pillByLabel("≤1h"));
    expect(onChange).toHaveBeenCalledWith("in_grace");
    expect(pillByLabel("≤1h").getAttribute("aria-checked")).toBe("true");
  });

  it("ArrowLeft from All wraps focus + selection to Ongoing", () => {
    const onChange = vi.fn();
    renderBucketFilterHarness("all", onChange);
    const all = pillByLabel("All");
    all.focus();
    dispatch(all, "ArrowLeft");
    expect(document.activeElement).toBe(pillByLabel("Ongoing"));
    expect(onChange).toHaveBeenCalledWith("ongoing");
  });

  it("Home and End jump to the first and last bucket", () => {
    const onChange = vi.fn();
    renderBucketFilterHarness("short", onChange);
    const short = pillByLabel("1h – 1d");
    short.focus();
    dispatch(short, "End");
    expect(document.activeElement).toBe(pillByLabel("Ongoing"));
    expect(onChange).toHaveBeenCalledWith("ongoing");

    dispatch(pillByLabel("Ongoing"), "Home");
    expect(document.activeElement).toBe(pillByLabel("All"));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("roving tabindex follows focus even while the controlled selected prop is stale", () => {
    render(<BucketFilter selected="all" onChange={() => undefined} />);
    const all = pillByLabel("All");
    expect(all.tabIndex).toBe(0);
    all.focus();
    dispatch(all, "ArrowRight");
    expect(document.activeElement).toBe(pillByLabel("≤1h"));
    expect(pillByLabel("≤1h").tabIndex).toBe(0);
    expect(pillByLabel("All").tabIndex).toBe(-1);
    expect(pillByLabel("All").getAttribute("aria-checked")).toBe("true");
  });

  it("axe passes with the keyboard contract in place", async () => {
    renderBucketFilterHarness("short");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PoolTablist — real production component
// ---------------------------------------------------------------------------
//
// Mounts the actual `<PoolTablist>` from `pool/[poolId]/_components/`,
// not a re-implementation. The page passes the same component the same
// props, so a regression on `role="tablist"` / `aria-controls` /
// button ordering / `LimitSelect` placement now fails this test.
//
// We don't render a sibling `<tabpanel>` — that's the page's
// responsibility, separate from the tablist component. The tablist's
// `aria-controls` wiring is asserted by id-string, which is enough to
// catch the contract regression Cursor flagged.

describe("PoolTablist a11y (real component)", () => {
  it("renders one button per `visibleTabs` entry with exactly one aria-selected=true", async () => {
    render(
      <>
        <PoolTablist
          visibleTabs={TABS}
          active="rebalances"
          onSelect={() => undefined}
          limit={50}
          onLimitChange={() => undefined}
        />
        {/* Stub panel so the tab buttons' `aria-controls` references
            resolve. The page renders this; here we render a minimal
            stand-in so axe's `aria-valid-attr-value` passes. */}
        <div
          role="tabpanel"
          id="panel-rebalances"
          aria-labelledby="tab-rebalances"
        >
          <p>rebalances</p>
        </div>
      </>,
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(TABS.length);
    const selected = Array.from(tabs).filter(
      (t) => t.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("tab-rebalances");
    expect(selected[0]!.getAttribute("aria-controls")).toBe("panel-rebalances");
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Pool data tabs");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("hides the inline LimitSelect when the active tab manages its own pagination", async () => {
    // `oracle` is in `TABS_WITHOUT_LIMIT_SELECT` — the LimitSelect's
    // `<select id="tab-limit">` should not be in the DOM.
    render(
      <>
        <PoolTablist
          visibleTabs={TABS}
          active="oracle"
          onSelect={() => undefined}
          limit={50}
          onLimitChange={() => undefined}
        />
        <div role="tabpanel" id="panel-oracle" aria-labelledby="tab-oracle">
          <p>oracle</p>
        </div>
      </>,
    );
    expect(container.querySelector("#tab-limit")).toBeNull();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("renders the inline LimitSelect for paginated tabs", async () => {
    render(
      <>
        <PoolTablist
          visibleTabs={TABS}
          active="swaps"
          onSelect={() => undefined}
          limit={50}
          onLimitChange={() => undefined}
        />
        <div role="tabpanel" id="panel-swaps" aria-labelledby="tab-swaps">
          <p>swaps</p>
        </div>
      </>,
    );
    expect(container.querySelector("#tab-limit")).not.toBeNull();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  // Each test renders a stub `<tabpanel>` with the same id pattern the
  // page uses (`panel-${tab}`) so the active tab's `aria-controls`
  // resolves cleanly under axe's `aria-valid-attr-value` check. The
  // role contract for the tablist itself is pinned above.

  // WAI-ARIA tablist keyboard contract — single tab stop with arrow
  // keys moving focus only; activation requires Enter/Space (manual
  // activation). The pool page's `onSelect` is wired to a router URL
  // change, which makes automatic activation a navigation-storm risk
  // and creates stale-prop races between keystrokes (codex flagged
  // both on PR #350). Manual activation is the WAI-ARIA-spec-supported
  // variant for this case.
  // See https://www.w3.org/WAI/ARIA/apg/patterns/tabs/.
  describe("PoolTablist: keyboard contract (manual activation)", () => {
    function tabs(): HTMLButtonElement[] {
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      );
    }

    function tabById(id: string): HTMLButtonElement {
      const match = tabs().find((t) => t.id === id);
      if (!match) throw new Error(`No tab with id ${id}`);
      return match;
    }

    function dispatch(el: HTMLElement, key: string) {
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }

    function renderTablist(active: Tab, onSelect: (t: Tab) => void) {
      render(
        <>
          <PoolTablist
            visibleTabs={TABS}
            active={active}
            onSelect={onSelect}
            limit={50}
            onLimitChange={() => undefined}
          />
          <div
            role="tabpanel"
            id={`panel-${active}`}
            aria-labelledby={`tab-${active}`}
          >
            <p>{active}</p>
          </div>
        </>,
      );
    }

    it("single tab stop: exactly one tabIndex=0 (the selected tab); the rest are tabIndex=-1", () => {
      renderTablist("rebalances", () => undefined);
      const tabbable = tabs().filter((t) => t.tabIndex === 0);
      const untabbable = tabs().filter((t) => t.tabIndex === -1);
      expect(tabbable).toHaveLength(1);
      expect(untabbable).toHaveLength(TABS.length - 1);
      expect(tabbable[0]!.id).toBe("tab-rebalances");
    });

    it("ArrowRight moves focus to the next tab WITHOUT activating it", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowRight");
      // TABS[3] = "rebalances"; next is TABS[4] = "liquidity"
      expect(document.activeElement).toBe(tabById("tab-liquidity"));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("ArrowLeft moves focus to the previous tab WITHOUT activating it", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowLeft");
      // TABS[3] = "rebalances"; previous is TABS[2] = "reserves"
      expect(document.activeElement).toBe(tabById("tab-reserves"));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("ArrowLeft from the first tab wraps focus to the last tab (no activation)", () => {
      const onSelect = vi.fn();
      renderTablist("providers", onSelect);
      const start = tabById("tab-providers");
      start.focus();
      dispatch(start, "ArrowLeft");
      const last = TABS[TABS.length - 1];
      expect(document.activeElement).toBe(tabById(`tab-${last}`));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("ArrowRight from the last tab wraps focus to the first tab (no activation)", () => {
      const onSelect = vi.fn();
      const last = TABS[TABS.length - 1]!;
      renderTablist(last, onSelect);
      const start = tabById(`tab-${last}`);
      start.focus();
      dispatch(start, "ArrowRight");
      expect(document.activeElement).toBe(tabById(`tab-${TABS[0]}`));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Home jumps focus to the first tab (no activation)", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "Home");
      expect(document.activeElement).toBe(tabById(`tab-${TABS[0]}`));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("End jumps focus to the last tab (no activation)", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "End");
      const last = TABS[TABS.length - 1];
      expect(document.activeElement).toBe(tabById(`tab-${last}`));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("roving tabindex: arrow-key focus moves the single tab stop without changing `active`", () => {
      // Codex finding on PR #350: with manual activation, focus can
      // move to a non-selected tab without changing `active`. Tying
      // `tabIndex={0}` to `active` would leave the user able to Tab
      // back to the selected tab instead of leaving the group.
      // Roving tabindex must follow focus.
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      // Initial: only "rebalances" is the tab stop.
      const initialTabbable = tabs().filter((t) => t.tabIndex === 0);
      expect(initialTabbable).toHaveLength(1);
      expect(initialTabbable[0]!.id).toBe("tab-rebalances");
      // ArrowLeft → focus moves to "reserves"; tab stop moves with it.
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowLeft");
      const movedTabbable = tabs().filter((t) => t.tabIndex === 0);
      expect(movedTabbable).toHaveLength(1);
      expect(movedTabbable[0]!.id).toBe("tab-reserves");
      expect(tabById("tab-rebalances").tabIndex).toBe(-1);
      // `active` (and therefore `aria-selected`) is unchanged.
      expect(onSelect).not.toHaveBeenCalled();
      expect(tabById("tab-rebalances").getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(tabById("tab-reserves").getAttribute("aria-selected")).toBe(
        "false",
      );
    });

    it("clicking the focused tab activates it (Enter/Space dispatch via native button onClick)", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      // Move focus with the keyboard, then commit with click — native
      // <button> handles Space/Enter as a click, so this exercises the
      // same activation path.
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowRight");
      const focused = document.activeElement as HTMLButtonElement;
      expect(focused.id).toBe("tab-liquidity");
      act(() => {
        focused.click();
      });
      expect(onSelect).toHaveBeenCalledWith("liquidity");
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("axe still passes after the keyboard contract is in place", async () => {
      renderTablist("swaps", () => undefined);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// CdpTroveTable — real production tablist
// ---------------------------------------------------------------------------

const CDP_COLLATERAL: CdpCollateral = {
  id: "gbpm",
  chainId: 42220,
  collIndex: 0,
  symbol: "GBPm",
  debtToken: "0xdebt",
  collToken: "0xcoll",
  troveManager: "0xtrove",
  stabilityPool: "0xstability",
  minDebt: "100000000000000000000",
  minBoldInSp: "0",
  minBoldAfterRebalance: "0",
  systemParamsLoaded: true,
  mcrBps: 11_000,
  ccrBps: 15_000,
  scrBps: 11_000,
};

describe("CdpTroveTable a11y (real component)", () => {
  function cdpTabs(): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
  }

  function cdpTabById(id: string): HTMLButtonElement {
    const match = cdpTabs().find((tab) => tab.id === id);
    if (!match) throw new Error(`No CDP trove tab with id ${id}`);
    return match;
  }

  function dispatchTabKey(el: HTMLElement, key: string) {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  it("uses tab semantics for Open and History views and passes axe", async () => {
    render(
      <CdpTroveTable
        openTroves={[]}
        allTroves={[]}
        interestBatches={[]}
        collateral={CDP_COLLATERAL}
      />,
    );

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Trove views");
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Open",
      "History",
    ]);
    const selected = tabs.filter(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("cdp-trove-tab-open");

    let panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe("cdp-trove-panel-open");
    expect(panel?.getAttribute("aria-labelledby")).toBe("cdp-trove-tab-open");
    expect(selected[0]!.getAttribute("aria-controls")).toBe(panel?.id);

    const history = tabs.find((tab) => tab.textContent?.trim() === "History");
    expect(history).toBeDefined();
    act(() => {
      history!.click();
    });
    panel = container.querySelector('[role="tabpanel"]');
    expect(history!.getAttribute("aria-selected")).toBe("true");
    expect(panel?.id).toBe("cdp-trove-panel-history");
    expect(panel?.getAttribute("aria-labelledby")).toBe(
      "cdp-trove-tab-history",
    );

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("moves focus with arrow keys and activates only on click", () => {
    render(
      <CdpTroveTable
        openTroves={[]}
        allTroves={[]}
        interestBatches={[]}
        collateral={CDP_COLLATERAL}
      />,
    );

    const open = cdpTabById("cdp-trove-tab-open");
    const history = cdpTabById("cdp-trove-tab-history");
    expect(open.tabIndex).toBe(0);
    expect(history.tabIndex).toBe(-1);

    open.focus();
    dispatchTabKey(open, "ArrowRight");

    expect(document.activeElement).toBe(history);
    expect(cdpTabById("cdp-trove-tab-open").tabIndex).toBe(-1);
    expect(cdpTabById("cdp-trove-tab-history").tabIndex).toBe(0);
    expect(cdpTabById("cdp-trove-tab-open").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      cdpTabById("cdp-trove-tab-history").getAttribute("aria-selected"),
    ).toBe("false");

    act(() => {
      history.click();
    });

    expect(
      cdpTabById("cdp-trove-tab-history").getAttribute("aria-selected"),
    ).toBe("true");
    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe("cdp-trove-panel-history");
    expect(panel?.getAttribute("aria-labelledby")).toBe(
      "cdp-trove-tab-history",
    );
  });
});
