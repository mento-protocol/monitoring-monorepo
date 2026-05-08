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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import { LimitSelect } from "@/components/controls";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import { PoolTablist } from "@/app/pool/[poolId]/_components/pool-tablist";
import { TABS } from "@/app/pool/[poolId]/_lib/constants";
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

  // Known gap (tracked in BACKLOG): WAI-ARIA radiogroup keyboard
  // pattern — exactly one radio in the group should be tabbable
  // (`tabIndex={0}` on the selected pill, `tabIndex={-1}` on the
  // others) with arrow keys moving focus. The current production
  // widget makes every pill tabbable. When the prod fix lands,
  // replace this todo with the real assertion.
  it.todo(
    "BridgeStatusFilter: keyboard contract — single tab stop with arrow-key focus movement",
  );
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

  // Known gap (tracked in BACKLOG): the WAI-ARIA tablist keyboard
  // pattern — single tab stop with arrow-key focus movement — is NOT
  // enforced. Every `role="tab"` button is naturally tabbable. When
  // the keyboard contract lands, replace this todo with a real
  // assertion (tabIndex distribution + key-event focus moves).
  it.todo(
    "PoolTablist: keyboard contract — single tab stop with arrow-key focus movement",
  );
});
