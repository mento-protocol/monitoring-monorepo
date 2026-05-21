"use client";

import { IntelCounterparties } from "./intel-counterparties";
import { IntelTransfers } from "./intel-transfers";
import { IntelWealthChart } from "./intel-wealth-chart";

/**
 * Sibling wrapper for the three Intel detail-page sections. Each panel
 * silent-degrades to null when no data, so the wrapper renders nothing when
 * the address has no Intel coverage.
 */
export function IntelPanels({ address }: { address: string }) {
  // Wrap in a flex container so the three panels get vertical gaps even
  // though the page-level `space-y-6` only sees IntelPanels as one child.
  return (
    <div className="space-y-6">
      <IntelCounterparties address={address} />
      <IntelTransfers address={address} />
      <IntelWealthChart address={address} />
    </div>
  );
}
