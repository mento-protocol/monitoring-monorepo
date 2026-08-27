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
  const pill = (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${troveStatusBadgeClasses(status)}`}
    >
      {label}
    </span>
  );
  if (tooltip == null) return pill;
  return (
    <Tooltip content={tooltip} label={`${label}: ${tooltip}`} asChild>
      {pill}
    </Tooltip>
  );
}
