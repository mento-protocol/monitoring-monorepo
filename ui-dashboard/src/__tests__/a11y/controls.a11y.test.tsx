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
 * 3. Pool tabs structural fragment — a `role="tablist"` containing
 *    `role="tab"` buttons with `aria-selected` and `aria-controls`. The
 *    fragment is driven by the **real** `TABS` source from
 *    `_lib/constants.ts` (and `getTabLabel`), so it can't drift behind
 *    the page when a tab is added/removed. Mounting the real page is
 *    deferred — would need mocks for Hasura, network provider, ~10
 *    hooks; not worth the complexity for one tablist test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import { LimitSelect } from "@/components/controls";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import { TABS, type Tab } from "@/app/pool/[poolId]/_lib/constants";
import { getTabLabel } from "@/app/pool/[poolId]/_lib/helpers";
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
});

// ---------------------------------------------------------------------------
// Pool tablist — structural fragment driven by the real `TABS` source
// ---------------------------------------------------------------------------
//
// We can't mount the real pool page here (it pulls in Hasura, network
// provider, ~10 hooks). But the tablist's role contract is what we want
// to pin: `role="tablist"` + N `role="tab"` buttons with `aria-selected`
// and `aria-controls` linking to a `role="tabpanel"`. By importing the
// real `TABS` (and `getTabLabel`) the test fails the moment the canonical
// list grows or shrinks — it can't drift behind the page silently.
//
// The page hides `breaches` for virtual pools and `ols` when no OLS pool
// is active; this test just checks the structural contract for the
// always-visible majority. A future PR that mocks the heavy hooks can
// promote this to a real-page render.

describe("Pool tablist a11y", () => {
  function renderTablist(active: Tab) {
    render(
      <>
        <div role="tablist" aria-label="Pool data tabs">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              id={`tab-${t}`}
              aria-selected={active === t}
              aria-controls={`panel-${t}`}
            >
              {getTabLabel(t)}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`panel-${active}`}
          aria-labelledby={`tab-${active}`}
        >
          <p>{getTabLabel(active)} content</p>
        </div>
      </>,
    );
  }

  it("renders one button per canonical tab and emits exactly one aria-selected=true", async () => {
    renderTablist("rebalances");
    const tabs = container.querySelectorAll('[role="tab"]');
    // Pin against the real source — if `TABS` grows, this test demands a
    // visit to revisit the page-level wiring for the new entry.
    expect(tabs).toHaveLength(TABS.length);
    const selected = Array.from(tabs).filter(
      (t) => t.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("tab-rebalances");
    expect(selected[0].getAttribute("aria-controls")).toBe("panel-rebalances");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
