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
 * 3. `PoolTablist` — the real production component (extracted from
 *    `pool/[poolId]/page.tsx` so the test mounts the actual JSX, not a
 *    re-implementation). Pins the `role="tablist"` + `role="tab"` +
 *    `aria-selected` + `aria-controls` contract. If the page-side
 *    rendering drops `role="tablist"` or breaks `aria-controls`, this
 *    test now catches it (Cursor finding on PR #342).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import { LimitSelect } from "@/components/controls";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import { PoolTablist } from "@/app/pool/[poolId]/_components/pool-tablist";
import { TABS, type Tab } from "@/app/pool/[poolId]/_lib/constants";
import type { BridgeStatus } from "@/lib/types";

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
    expect(checked[0].textContent).toContain("Delivered");
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
      expect(tabbable[0].textContent).toContain("Attested");
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
      expect(tabbable[0].textContent?.trim()).toBe("All");
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
    expect(selected[0].id).toBe("tab-rebalances");
    expect(selected[0].getAttribute("aria-controls")).toBe("panel-rebalances");
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
  // keys moving focus AND activating the tab (automatic activation).
  // See https://www.w3.org/WAI/ARIA/apg/patterns/tabs/.
  describe("PoolTablist: keyboard contract", () => {
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
      expect(tabbable[0].id).toBe("tab-rebalances");
    });

    it("ArrowRight moves focus to the next tab AND activates it (automatic activation)", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowRight");
      // TABS[3] = "rebalances"; next is TABS[4] = "liquidity"
      expect(onSelect).toHaveBeenCalledWith("liquidity");
      expect(document.activeElement).toBe(tabById("tab-liquidity"));
    });

    it("ArrowLeft moves focus to the previous tab AND activates it", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "ArrowLeft");
      // TABS[3] = "rebalances"; previous is TABS[2] = "reserves"
      expect(onSelect).toHaveBeenCalledWith("reserves");
      expect(document.activeElement).toBe(tabById("tab-reserves"));
    });

    it("ArrowLeft from the first tab wraps to the last tab", () => {
      const onSelect = vi.fn();
      renderTablist("providers", onSelect);
      const start = tabById("tab-providers");
      start.focus();
      dispatch(start, "ArrowLeft");
      const last = TABS[TABS.length - 1];
      expect(onSelect).toHaveBeenCalledWith(last);
      expect(document.activeElement).toBe(tabById(`tab-${last}`));
    });

    it("ArrowRight from the last tab wraps to the first tab", () => {
      const onSelect = vi.fn();
      const last = TABS[TABS.length - 1];
      renderTablist(last, onSelect);
      const start = tabById(`tab-${last}`);
      start.focus();
      dispatch(start, "ArrowRight");
      expect(onSelect).toHaveBeenCalledWith(TABS[0]);
      expect(document.activeElement).toBe(tabById(`tab-${TABS[0]}`));
    });

    it("Home jumps focus + activation to the first tab", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "Home");
      expect(onSelect).toHaveBeenCalledWith(TABS[0]);
      expect(document.activeElement).toBe(tabById(`tab-${TABS[0]}`));
    });

    it("End jumps focus + activation to the last tab", () => {
      const onSelect = vi.fn();
      renderTablist("rebalances", onSelect);
      const start = tabById("tab-rebalances");
      start.focus();
      dispatch(start, "End");
      const last = TABS[TABS.length - 1];
      expect(onSelect).toHaveBeenCalledWith(last);
      expect(document.activeElement).toBe(tabById(`tab-${last}`));
    });

    it("axe still passes after the keyboard contract is in place", async () => {
      renderTablist("swaps", () => undefined);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
