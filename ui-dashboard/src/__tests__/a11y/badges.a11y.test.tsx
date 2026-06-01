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
  // Status → expected visible label. Values are the labels the component
  // promises to render (see `configs` in src/components/badges.tsx). The
  // multi-variant axe pass below only catches missing accessible names; this
  // table catches a silent label-drift refactor (e.g. CRITICAL losing its
  // text and falling back to color-only signalling).
  const HEALTH_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ["OK", "OK"],
    ["WARN", "WARN"],
    ["WEEKEND", "Weekend"],
    ["HALTED", "Halted"],
    ["CRITICAL", "CRITICAL"],
    ["N/A", "N/A"],
  ];

  it("has no axe violations across all status variants", async () => {
    // Render every status simultaneously so axe sees the full enum surface
    // in one pass — keeps the test count bounded.
    render(
      <ul aria-label="Pool health badges">
        {HEALTH_VARIANTS.map(([status]) => (
          <li key={status}>
            <HealthBadge status={status} />
          </li>
        ))}
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("every status variant carries its expected visible text label", () => {
    render(
      <ul>
        {HEALTH_VARIANTS.map(([status]) => (
          <li key={status} data-testid={`health-${status}`}>
            <HealthBadge status={status} />
          </li>
        ))}
      </ul>,
    );
    for (const [status, expected] of HEALTH_VARIANTS) {
      const li = container.querySelector(`[data-testid="health-${status}"]`);
      expect(li?.textContent).toContain(expected);
    }
  });

  it("dot is aria-hidden across every status variant (color signalled but not announced)", () => {
    // The assertion is a general property of HealthBadge, not specific to
    // CRITICAL. Render every variant in a single tree, then assert each
    // badge wraps its dot in an `aria-hidden="true"` subtree so the
    // accessible name path strips it (claude[bot] PR #342 finding).
    render(
      <ul>
        {HEALTH_VARIANTS.map(([status]) => (
          <li key={status} data-testid={`dot-${status}`}>
            <HealthBadge status={status} />
          </li>
        ))}
      </ul>,
    );
    for (const [status] of HEALTH_VARIANTS) {
      const li = container.querySelector(`[data-testid="dot-${status}"]`);
      expect(li?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});

describe("LimitBadge a11y", () => {
  const LIMIT_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ["OK", "OK"],
    ["WARN", "WARN"],
    ["CRITICAL", "CRITICAL"],
    ["N/A", "N/A"],
  ];

  it("has no axe violations across all status variants", async () => {
    render(
      <ul aria-label="Trading limit badges">
        {LIMIT_VARIANTS.map(([status]) => (
          <li key={status}>
            <LimitBadge status={status} />
          </li>
        ))}
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("every status variant carries its expected visible text label", () => {
    render(
      <ul>
        {LIMIT_VARIANTS.map(([status]) => (
          <li key={status} data-testid={`limit-${status}`}>
            <LimitBadge status={status} />
          </li>
        ))}
      </ul>,
    );
    for (const [status, expected] of LIMIT_VARIANTS) {
      const li = container.querySelector(`[data-testid="limit-${status}"]`);
      expect(li?.textContent).toContain(expected);
    }
  });
});

describe("SourceBadge / KindBadge a11y", () => {
  // SourceBadge derives its label from the input source string: any value
  // containing "fpmm" → "FPMM"; everything else → "Virtual".
  const SOURCE_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ["fpmm_factory", "FPMM"],
    ["virtual_pool_factory", "Virtual"],
  ];

  // KindBadge passes through the input as the visible text.
  const KIND_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ["MINT", "MINT"],
    ["BURN", "BURN"],
  ];

  it("SourceBadge has no axe violations across variants", async () => {
    render(
      <ul aria-label="Pool source badges">
        {SOURCE_VARIANTS.map(([source]) => (
          <li key={source}>
            <SourceBadge source={source} />
          </li>
        ))}
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("SourceBadge: every variant carries its expected visible text label", () => {
    render(
      <ul>
        {SOURCE_VARIANTS.map(([source]) => (
          <li key={source} data-testid={`source-${source}`}>
            <SourceBadge source={source} />
          </li>
        ))}
      </ul>,
    );
    for (const [source, expected] of SOURCE_VARIANTS) {
      const li = container.querySelector(`[data-testid="source-${source}"]`);
      expect(li?.textContent).toContain(expected);
    }
  });

  it("KindBadge has no axe violations across variants", async () => {
    render(
      <ul aria-label="Liquidity event badges">
        {KIND_VARIANTS.map(([kind]) => (
          <li key={kind}>
            <KindBadge kind={kind} />
          </li>
        ))}
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("KindBadge: every variant carries its expected visible text label", () => {
    render(
      <ul>
        {KIND_VARIANTS.map(([kind]) => (
          <li key={kind} data-testid={`kind-${kind}`}>
            <KindBadge kind={kind} />
          </li>
        ))}
      </ul>,
    );
    for (const [kind, expected] of KIND_VARIANTS) {
      const li = container.querySelector(`[data-testid="kind-${kind}"]`);
      expect(li?.textContent).toContain(expected);
    }
  });
});

describe("Bridge badge a11y", () => {
  // STUCK is a derived overlay, not a raw BridgeStatus — surfaces once a
  // SENT/ATTESTED transfer ages past 24h. The three in-flight states all
  // collapse to "In progress" via `bridgeStatusLabel` (intentional UX —
  // operators see one phase, not three sub-phases).
  const BRIDGE_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ["PENDING", "Pending"],
    ["SENT", "In progress"],
    ["ATTESTED", "In progress"],
    ["DELIVERED", "Delivered"],
    ["QUEUED_INBOUND", "In progress"],
    ["CANCELLED", "Cancelled"],
    ["FAILED", "Failed"],
    ["STUCK", "Stuck"],
  ];

  it("BridgeStatusBadge passes axe across every status overlay", async () => {
    render(
      <ul aria-label="Bridge status badges">
        {BRIDGE_VARIANTS.map(([status]) => (
          <li key={status}>
            <BridgeStatusBadge
              status={
                status as Parameters<typeof BridgeStatusBadge>[0]["status"]
              }
            />
          </li>
        ))}
      </ul>,
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("every status variant carries its expected visible text label", () => {
    render(
      <ul>
        {BRIDGE_VARIANTS.map(([status]) => (
          <li key={status} data-testid={`bridge-${status}`}>
            <BridgeStatusBadge
              status={
                status as Parameters<typeof BridgeStatusBadge>[0]["status"]
              }
            />
          </li>
        ))}
      </ul>,
    );
    for (const [status, expected] of BRIDGE_VARIANTS) {
      const li = container.querySelector(`[data-testid="bridge-${status}"]`);
      expect(li?.textContent).toContain(expected);
    }
  });

  it("BridgeProviderBadge passes axe and renders the expected label per provider", async () => {
    render(
      <div aria-label="Bridge provider badges" data-testid="bridge-provider">
        <BridgeProviderBadge provider="WORMHOLE" />
      </div>,
    );
    const wrap = container.querySelector('[data-testid="bridge-provider"]');
    // The component maps WORMHOLE → "Wormhole"; assert the label renders so
    // a refactor that drops the Record lookup (and falls through to the
    // raw enum value) trips this test.
    expect(wrap?.textContent).toContain("Wormhole");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
