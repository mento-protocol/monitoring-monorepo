import { Tooltip } from "@/components/tooltip";
import {
  troveStatusBadgeClasses,
  troveStatusLabel,
  troveStatusTooltip,
} from "../_lib/status";

/** Header status pill using indexer vocabulary (active/zombie/closed/
 *  liquidated/redeemed), with a tooltip for every status — the two
 *  non-obvious ones (zombie, redeemed) carry the design doc's own
 *  explanation; the rest get a matching one-sentence gloss. */
export function TroveStatusBadge({ status }: { status: string }) {
  const label = troveStatusLabel(status);
  const tooltip = troveStatusTooltip(status);
  if (tooltip == null) {
    return (
      <span
        className={`inline-block rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${troveStatusBadgeClasses(status)}`}
      >
        {label}
      </span>
    );
  }
  return (
    <Tooltip content={tooltip} label={`${label}: ${tooltip}`} asChild>
      {/* `button`, not `span` — `asChild` clones this element as-is as the
          tooltip's focus trigger (see @/components/tooltip.tsx). A plain
          span isn't reachable by Tab, so keyboard users could never open
          the tooltip; a native interactive element is focusable without an
          explicit tabIndex (which jsx-a11y/no-noninteractive-tabindex
          rejects on a non-interactive element like a bare span). */}
      <button
        type="button"
        className={`inline-block rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${troveStatusBadgeClasses(status)}`}
      >
        {label}
      </button>
    </Tooltip>
  );
}
