import { bridgeStatusClasses, bridgeStatusLabel } from "@/lib/bridge-status";
import type { BridgeStatusOverlay } from "@/lib/types";

export function BridgeStatusBadge({ status }: { status: BridgeStatusOverlay }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium ${bridgeStatusClasses(
        status,
      )}`}
    >
      {bridgeStatusLabel(status)}
    </span>
  );
}
