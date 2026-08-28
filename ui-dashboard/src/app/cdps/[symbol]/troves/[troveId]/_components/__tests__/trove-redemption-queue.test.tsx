/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TroveQueueModel, TroveQueueRung } from "../../_lib/queue";
import type { TroveQueueState } from "../../_lib/use-trove-queue";
import { TroveRedemptionQueuePanel } from "../trove-redemption-queue";

const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function rateWei(bps: number): string {
  return ((BigInt(bps) * D18) / BigInt(10_000)).toString();
}

function rung(overrides: Partial<TroveQueueRung> = {}): TroveQueueRung {
  return {
    rate: rateWei(50),
    debt: wei(6_200),
    troveCount: 1,
    position: 1,
    containsThisTrove: false,
    ...overrides,
  };
}

function readyModel(
  overrides: Partial<Extract<TroveQueueModel, { kind: "ready" }>> = {},
): TroveQueueModel {
  const rungs = overrides.rungs ?? [
    rung(),
    rung({
      rate: rateWei(160),
      debt: wei(28_081),
      position: 2,
      containsThisTrove: true,
    }),
  ];
  return {
    kind: "ready",
    rungs,
    thisTrove: {
      position: 2,
      rateLevels: rungs.length,
      rate: rateWei(160),
      shieldDebt: wei(6_200),
    },
    ...overrides,
  };
}

/** A consistent "not a queue member" model: no rung claims this trove. */
function modelWithoutThisTrove(): TroveQueueModel {
  return {
    kind: "ready",
    rungs: [
      rung(),
      rung({ rate: rateWei(160), debt: wei(28_081), position: 2 }),
    ],
    thisTrove: null,
  };
}

function state(overrides: Partial<TroveQueueState> = {}): TroveQueueState {
  return {
    model: readyModel(),
    isLoading: false,
    error: undefined,
    hasLoadedOnce: true,
    ...overrides,
  };
}

type Handle = { container: HTMLElement; root: Root };

let handle: Handle | null = null;

function render(
  queue: TroveQueueState,
  { troveStatus = "active", debtSymbol = "GBPm" } = {},
) {
  act(() => {
    handle!.root.render(
      <TroveRedemptionQueuePanel
        queue={queue}
        troveStatus={troveStatus}
        debtSymbol={debtSymbol}
      />,
    );
  });
}

function text(): string {
  return handle!.container.textContent ?? "";
}

describe("TroveRedemptionQueuePanel", () => {
  beforeEach(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    handle = { container, root: createRoot(container) };
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
    }
    handle = null;
  });

  it("renders the approved ladder: column headers, proportional bars, and the highlighted row", () => {
    render(state());

    const table = handle!.container.querySelector(
      'table[aria-label="Redemption queue ladder"]',
    );
    expect(table).not.toBeNull();
    const headers = Array.from(table!.querySelectorAll("th")).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual([
      "Interest rate",
      "Debt at this rate",
      "Queue position",
    ]);

    const body = text();
    expect(body).toContain("0.50%");
    expect(body).toContain("1.60%");
    expect(body).toContain("#1");
    expect(body).toContain("#2 · this trove");
    // Footnote: proportionality + the lastZombieTroveId remnant nuance.
    expect(body).toContain(
      "Bar length is proportional to the debt at each rate.",
    );
    expect(body).toContain("lastZombieTroveId");
    // Bars are proportional to the largest rung's debt.
    const bars = Array.from(
      handle!.container.querySelectorAll<HTMLElement>(
        'td [aria-hidden="true"] > div',
      ),
    );
    // jsdom serializes "100.0%" back as "100%".
    expect(bars.map((bar) => bar.style.width)).toEqual(["22.1%", "100%"]);
  });

  it("summarizes rank and shield for an active positioned trove, as a live region", () => {
    render(state());

    const status = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).find((node) => node.textContent?.includes("queue position"));
    expect(status?.textContent).toContain(
      "Current rate 1.60% — queue position #2 of 2 rate levels.",
    );
    expect(status?.textContent).toContain(
      "6,200.00 GBPm of active debt at lower rates shields this trove today.",
    );
  });

  it("states plainly that the front of the queue has no shield", () => {
    render(
      state({
        model: readyModel({
          rungs: [rung({ containsThisTrove: true })],
          thisTrove: {
            position: 1,
            rateLevels: 1,
            rate: rateWei(50),
            shieldDebt: "0",
          },
        }),
      }),
    );
    expect(text()).toContain(
      "No lower-rate active debt shields this trove — it is redeemed first.",
    );
  });

  it("does not claim first place when the lowest rung is shared — the tiebreak decides", () => {
    render(
      state({
        model: readyModel({
          rungs: [rung({ containsThisTrove: true, troveCount: 2 })],
          thisTrove: {
            position: 1,
            rateLevels: 1,
            rate: rateWei(50),
            shieldDebt: "0",
          },
        }),
      }),
    );
    expect(text()).not.toContain("it is redeemed first.");
    expect(text()).toContain(
      "order inside the level decided by the queue's tiebreak",
    );
  });

  it("states that the panel shows current state only — historical rank is not tracked", () => {
    render(state());
    expect(text()).toContain("Historical rank is not tracked");
  });

  it("explains a zombie trove's missing position without inventing a rank", () => {
    render(state({ model: modelWithoutThisTrove() }), {
      troveStatus: "zombie",
    });
    const body = text();
    expect(body).toContain("This trove is a zombie");
    expect(body).toContain("outside the rate-ordered queue");
    // No row claims " · this trove" and no rank is invented.
    expect(body).not.toContain("this trove");
  });

  it("explains a closed trove left the queue while still showing the market ladder", () => {
    render(state({ model: modelWithoutThisTrove() }), {
      troveStatus: "redeemed",
    });
    const body = text();
    expect(body).toContain(
      "This trove is redeemed — it is no longer in the redemption queue.",
    );
    expect(
      handle!.container.querySelector(
        'table[aria-label="Redemption queue ladder"]',
      ),
    ).not.toBeNull();
  });

  it("discloses an unavailable position for an active trove missing from the fetch", () => {
    render(state({ model: modelWithoutThisTrove() }));
    expect(text()).toContain("queue position is unavailable");
  });

  it("suppresses rank, shield, AND the ladder at the fetch cap — never a partial calculation", () => {
    render(state({ model: { kind: "capped" } }));

    const body = text();
    expect(body).toContain(
      "Queue position and shield are hidden because the full open-trove set is not loaded",
    );
    expect(body).toContain("1,000");
    expect(
      handle!.container.querySelector(
        'table[aria-label="Redemption queue ladder"]',
      ),
    ).toBeNull();
    expect(body).not.toContain("#1");
    // The suppression notice is a live region.
    const status = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).find((node) => node.textContent?.includes("hidden"));
    expect(status).toBeDefined();
  });

  it("suppresses rank and shield when active batch rates are unresolved", () => {
    render(state({ model: { kind: "unresolved-rates", unresolvedCount: 2 } }));
    const body = text();
    expect(body).toContain("Queue position and shield are unavailable");
    expect(body).toContain("2 active troves carry");
    expect(
      handle!.container.querySelector(
        'table[aria-label="Redemption queue ladder"]',
      ),
    ).toBeNull();
  });

  it("replaces the ladder with the urgent-redemption notice while the market is shut down", () => {
    render(state({ model: { kind: "shutdown", shutDownAt: "1750000000" } }));

    const body = text();
    expect(body).toContain("This market is shut down");
    expect(body).toContain(
      "rate order does not decide which troves are redeemed",
    );
    expect(
      handle!.container.querySelector(
        'table[aria-label="Redemption queue ladder"]',
      ),
    ).toBeNull();
    expect(body).not.toContain("queue position #");
    const status = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).find((node) => node.textContent?.includes("shut down"));
    expect(status).toBeDefined();
  });

  it("renders the confirmed-empty queue distinctly from loading", () => {
    render(state({ model: { kind: "empty" } }));
    expect(text()).toContain(
      "No active troves in this market — the redemption queue is empty.",
    );
    expect(
      handle!.container.querySelector(
        '[aria-label="Loading redemption queue"]',
      ),
    ).toBeNull();
  });

  it("shows a labeled loading skeleton until the first response resolves", () => {
    render(state({ model: null, isLoading: true, hasLoadedOnce: false }));
    const loading = handle!.container.querySelector(
      '[role="status"][aria-label="Loading redemption queue"]',
    );
    expect(loading).not.toBeNull();
    expect(text()).not.toContain("queue position #");
  });

  it("shows a hard error only for a first load that never resolved", () => {
    render(
      state({
        model: null,
        error: new Error("queue backend down"),
        hasLoadedOnce: false,
      }),
    );
    const alert = handle!.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Failed to load the redemption queue — queue backend down. Retrying automatically.",
    );
    expect(text()).not.toContain("refresh failed");
  });

  it("keeps the last confirmed ladder with a stale-refresh notice after a poll failure", () => {
    render(
      state({
        error: new Error("queue revalidation stalled"),
      }),
    );
    const body = text();
    expect(body).toContain("Redemption queue refresh failed");
    expect(body).toContain("showing the last confirmed state");
    expect(body).toContain("queue revalidation stalled");
    // The confirmed ladder stays on screen.
    expect(body).toContain("#2 · this trove");
  });
});
