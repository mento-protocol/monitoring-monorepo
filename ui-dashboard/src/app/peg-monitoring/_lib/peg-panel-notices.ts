import type { PegSource } from "@/lib/peg-monitoring";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";

/**
 * Why the policy-selected market cannot set peg status. Carried over verbatim
 * from the pre-redesign evidence panel so the degraded copy stays stable.
 */
export function primaryMarketProblem(
  source: PegSource,
  asset: PegAssetPresentation,
): string {
  if (source.listingState === "halted")
    return "Trading is halted on this market.";
  if (source.listingState === "absent")
    return "This asset is not listed on the market.";
  if (source.venueState === "halted")
    return "The market reports that trading is halted.";
  if (source.capped)
    return "The market could not fill the full test sale. Its partial price does not set peg status.";
  if (!source.healthy)
    return "This market did not return a usable price check.";
  if (source.observationAt === null)
    return "This market did not return a current observation.";
  if (source.executablePrice === null)
    return "This market did not return a full-size sale price.";
  return (
    asset.uncertaintyReason ??
    "This market cannot currently provide the price used to set peg status."
  );
}

function retainedCriticalNotice(
  asset: PegAssetPresentation,
  stale: boolean,
  previousPolicy: boolean,
): string | null {
  if (asset.tone !== "critical") return null;
  if (stale)
    return `Last confirmed critical result: ${asset.reasons[0] ?? "A critical monitoring condition was active."} The data is stale, so this does not confirm the problem is still active.`;
  if (previousPolicy)
    return `Critical result under the previous alert policy: ${asset.reasons[0] ?? "A critical monitoring condition was recorded."} The current approved policy has not confirmed this result.`;
  return null;
}

export type PanelNotice = {
  tone: "critical" | "warning";
  text: string;
  live: "alert" | "status";
};

/** The panel's leading conclusion line, or `null` when the row is clean. */
export function panelNotice(
  asset: PegAssetPresentation,
  stale: boolean,
  previousPolicy: boolean,
): PanelNotice | null {
  if (asset.currentCritical)
    return {
      tone: "critical",
      live: "alert",
      text:
        asset.reasons[0] ??
        asset.uncertaintyReason ??
        "A critical monitoring condition is active.",
    };
  const retained = retainedCriticalNotice(asset, stale, previousPolicy);
  if (retained !== null)
    return { tone: "warning", live: "status", text: retained };
  if (!asset.uncertain && asset.tone !== "warning") return null;
  const text = asset.uncertaintyReason ?? asset.reasons[0];
  return text === undefined ? null : { tone: "warning", live: "status", text };
}

export const PREVIOUS_POLICY_NOTICE =
  "Using the previous alert policy. The latest complete check has not moved to the current approved policy yet.";

export function staleNotice(ageLabel: string): string {
  return `Showing the last confirmed check, produced ${ageLabel} ago. These values are not current.`;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** "Slippage when selling 50k EUROP for EUR on Bitvavo". */
export function measurementLabel(source: PegSource | null): string {
  if (source === null) return "No primary market is available for this peg";
  const provider =
    source.provider.length === 0
      ? source.provider
      : `${source.provider[0]!.toUpperCase()}${source.provider.slice(1)}`;
  // The mockup writes "50k", so the compact formatter's "K" drops a case.
  const size =
    source.referenceSize === null
      ? "a full-size"
      : compact.format(source.referenceSize).replace("K", "k");
  const quote = source.convertVia?.toCurrency ?? source.quoteCurrency;
  return `Slippage when selling ${size} ${source.baseCurrency} for ${quote} on ${provider}`;
}
