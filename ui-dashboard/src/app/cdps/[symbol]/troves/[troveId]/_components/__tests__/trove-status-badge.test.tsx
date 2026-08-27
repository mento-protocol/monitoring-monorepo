/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TroveStatusBadge } from "../trove-status-badge";
import { TROVE_STATUSES, troveStatusLabel } from "../../_lib/status";

function render(node: React.ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe("TroveStatusBadge", () => {
  let handle: { container: HTMLDivElement; root: Root } | null = null;

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
  });

  it.each(TROVE_STATUSES)(
    "renders the %s label with a non-empty tooltip",
    (status) => {
      handle = render(<TroveStatusBadge status={status} />);
      const trigger = handle.container.querySelector("[aria-describedby]");
      expect(trigger).not.toBeNull();
      // The trigger IS the cloned pill (asChild) — its own textContent is
      // just the visible label, not the sibling tooltip popover's content.
      expect(trigger?.textContent).toBe(troveStatusLabel(status));
      const tooltipId = trigger?.getAttribute("aria-describedby");
      const tooltip = handle.container.ownerDocument.getElementById(tooltipId!);
      expect(tooltip?.textContent?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it("renders zombie's unredeemable explanation and redeemed's fully-redeemed explanation", () => {
    handle = render(<TroveStatusBadge status="zombie" />);
    let trigger = handle.container.querySelector("[aria-describedby]");
    let tooltipId = trigger?.getAttribute("aria-describedby");
    expect(
      handle.container.ownerDocument.getElementById(tooltipId!)?.textContent,
    ).toContain("unredeemable until adjusted");
    act(() => handle!.root.unmount());
    handle.container.remove();

    handle = render(<TroveStatusBadge status="redeemed" />);
    trigger = handle.container.querySelector("[aria-describedby]");
    tooltipId = trigger?.getAttribute("aria-describedby");
    expect(
      handle.container.ownerDocument.getElementById(tooltipId!)?.textContent,
    ).toContain("Fully redeemed to zero");
  });

  it("falls back to the raw status string for an unknown value", () => {
    handle = render(<TroveStatusBadge status="some-future-status" />);
    expect(handle.container.textContent).toBe("some-future-status");
    // No tooltip trigger for an unrecognized status.
    expect(handle.container.querySelector("[aria-describedby]")).toBeNull();
  });

  it("is keyboard-focusable — asChild clones a plain span, which needs an explicit tabIndex to be Tab-reachable", () => {
    handle = render(<TroveStatusBadge status="active" />);
    const trigger = handle.container.querySelector("[aria-describedby]");
    expect(trigger?.tagName).toBe("SPAN");
    expect(trigger?.getAttribute("tabindex")).toBe("0");
  });
});
