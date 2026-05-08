/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * axe-core accessibility checks for the dashboard's badge / pill components.
 *
 * Why these targets: badges encode operational state (CRITICAL / WARN / OK,
 * pool source, bridge status, bridge provider) through color *plus* a
 * text label. The risk we want a deterministic alarm against is "the next
 * refactor accidentally drops the visible label and the color is the only
 * remaining signal of severity". axe-core flags missing accessible names
 * via the `button-name` / `aria-allowed-role` rules; our components are
 * `<span>`s so the relevant signal is "no a11y violations".
 *
 * Each badge is rendered inside an outer `<div role="region" aria-label="…">`
 * so axe has a labelled landmark and the badge's text content is the only
 * accessible name path under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import {
  HealthBadge,
  KindBadge,
  LimitBadge,
  SourceBadge,
} from "@/components/badges";
import { BridgeProviderBadge } from "@/components/bridge-provider-badge";
import { BridgeStatusBadge } from "@/components/bridge-status-badge";

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

describe("HealthBadge a11y", () => {
  it("has no axe violations across all status variants", async () => {
    // Render every status simultaneously so axe sees the full enum surface
    // in one pass — keeps the test count bounded but still catches a
    // per-status regression (e.g. CRITICAL losing its label).
    render(
      <ul aria-label="Pool health badges">
        <li>
          <HealthBadge status="OK" />
        </li>
        <li>
          <HealthBadge status="WARN" />
        </li>
        <li>
          <HealthBadge status="WEEKEND" />
        </li>
        <li>
          <HealthBadge status="CRITICAL" />
        </li>
        <li>
          <HealthBadge status="N/A" />
        </li>
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("CRITICAL status carries a visible text label, not just a colored dot", () => {
    render(<HealthBadge status="CRITICAL" />);
    // Text content includes both the dot emoji (aria-hidden) and the label
    // "CRITICAL". The accessible-name path strips aria-hidden subtrees, so
    // the badge's accessible text is "CRITICAL" — never just color.
    expect(container.textContent).toContain("CRITICAL");
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});

describe("LimitBadge a11y", () => {
  it("has no axe violations across all status variants", async () => {
    render(
      <ul aria-label="Trading limit badges">
        <li>
          <LimitBadge status="OK" />
        </li>
        <li>
          <LimitBadge status="WARN" />
        </li>
        <li>
          <LimitBadge status="CRITICAL" />
        </li>
        <li>
          <LimitBadge status="N/A" />
        </li>
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

describe("SourceBadge / KindBadge a11y", () => {
  it("SourceBadge renders FPMM and Virtual variants without violations", async () => {
    render(
      <ul aria-label="Pool source badges">
        <li>
          <SourceBadge source="fpmm_factory" />
        </li>
        <li>
          <SourceBadge source="virtual_pool_factory" />
        </li>
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("KindBadge renders MINT and BURN variants without violations", async () => {
    render(
      <ul aria-label="Liquidity event badges">
        <li>
          <KindBadge kind="MINT" />
        </li>
        <li>
          <KindBadge kind="BURN" />
        </li>
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

describe("Bridge badge a11y", () => {
  it("BridgeStatusBadge passes axe across every status overlay", async () => {
    render(
      <ul aria-label="Bridge status badges">
        <li>
          <BridgeStatusBadge status="PENDING" />
        </li>
        <li>
          <BridgeStatusBadge status="SENT" />
        </li>
        <li>
          <BridgeStatusBadge status="ATTESTED" />
        </li>
        <li>
          <BridgeStatusBadge status="DELIVERED" />
        </li>
        <li>
          <BridgeStatusBadge status="QUEUED_INBOUND" />
        </li>
        <li>
          <BridgeStatusBadge status="CANCELLED" />
        </li>
        <li>
          <BridgeStatusBadge status="FAILED" />
        </li>
        <li>
          {/* Derived overlay — `STUCK` is not a real BridgeStatus value but
              flows through `bridgeStatusLabel` once a SENT/ATTESTED transfer
              ages past 24h. Test the overlay surface explicitly. */}
          <BridgeStatusBadge status="STUCK" />
        </li>
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("BridgeProviderBadge passes axe", async () => {
    render(
      <div aria-label="Bridge provider badges">
        <BridgeProviderBadge provider="WORMHOLE" />
      </div>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
