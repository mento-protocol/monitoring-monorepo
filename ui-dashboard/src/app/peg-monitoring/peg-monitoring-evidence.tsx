import Link from "next/link";
import {
  PEG_GRAFANA_ALERTS_URL,
  type PegMonitor,
  type PegMonitoringViewState,
  type PegSource,
} from "@/lib/peg-monitoring";
import type {
  PegAssetPresentation,
  PegMonitoringPresentation,
} from "@/lib/peg-monitoring-presentation";
import { sourceHasUnavailableEvidence } from "@/lib/peg-monitoring-presentation-safety";
import { buildPoolDetailHref } from "@/lib/routing";
import {
  StatusPill,
  formatAge,
  formatFraction,
  shortAddress,
} from "./peg-monitoring-evidence-primitives";
import { PegMonitoringAlertSettings } from "./peg-monitoring-alert-settings";
import {
  OtherMarkets,
  SaleMeasurement,
  marketName,
} from "./peg-monitoring-market-evidence";
import { PegMonitoringTechnicalRecord } from "./peg-monitoring-technical-record";

type ConfirmedState = Extract<
  PegMonitoringViewState,
  { kind: "current" | "stale" }
>;

function sourceProblem(source: PegSource, asset: PegAssetPresentation): string {
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

function CheckStatus({ state }: { state: ConfirmedState }): React.JSX.Element {
  if (state.kind === "current")
    return (
      <section
        data-testid="peg-status"
        aria-labelledby="peg-check-status-heading"
        className="rounded-lg border border-emerald-500/20 bg-emerald-950/30 px-4 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="peg-check-status-heading"
            role="status"
            className="text-sm font-semibold text-emerald-100"
          >
            Data is current
          </h2>
          <StatusPill label="Fresh" tone="good" />
        </div>
        <p
          data-testid="peg-status-age"
          className="mt-1 text-xs text-emerald-200"
        >
          Produced {formatAge(state.ageMs)} ago
        </p>
      </section>
    );

  const why = {
    age: "No new monitoring package arrived within 90 seconds.",
    "clock-skew": "The package timestamp is ahead of this browser clock.",
    "refresh-error": "The latest dashboard refresh failed.",
  }[state.reason];
  return (
    <section
      data-testid="peg-status"
      aria-labelledby="peg-check-status-heading"
      className="rounded-lg border border-amber-500/30 bg-amber-950/40 px-4 py-3"
    >
      <h2
        id="peg-check-status-heading"
        role="status"
        className="text-sm font-semibold text-amber-100"
      >
        Data is stale — showing the last confirmed check
      </h2>
      <p className="mt-1 text-xs leading-5 text-amber-100">{why}</p>
      <p data-testid="peg-status-age" className="mt-1 text-xs text-amber-100">
        Produced {formatAge(state.ageMs)} ago. The retained evidence is not
        current.
      </p>
    </section>
  );
}

function PreviousPolicyNotice({
  state,
}: {
  state: ConfirmedState;
}): React.JSX.Element | null {
  return usesPreviousPolicy(state) ? (
    <div
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
    >
      <span className="font-semibold">Using the previous alert policy.</span>{" "}
      The latest complete check has not moved to the current approved policy
      yet.
    </div>
  ) : null;
}

function usesPreviousPolicy(state: ConfirmedState): boolean {
  return (
    state.data.policySlot === "previous" ||
    state.data.producedPolicyVersion !== state.data.approvedActivePolicyVersion
  );
}

function DecisionMarket({
  asset,
  nowMs,
  confirmedAtMs,
  stale,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  confirmedAtMs: number;
  stale: boolean;
}): React.JSX.Element {
  const source = asset.deepSource;
  // A stale package remains evidence of the last confirmed check. Evaluate its
  // source freshness at the package timestamp, rather than against the moving
  // browser clock, just as we do for supporting markets.
  const usable = !sourceHasUnavailableEvidence(
    source,
    stale ? confirmedAtMs : nowMs,
  );
  return (
    <section
      data-testid={`peg-decision-market-${asset.asset.asset}`}
      aria-labelledby={`peg-decision-market-heading-${asset.asset.asset}`}
      className="rounded-lg border border-slate-800 bg-slate-950/35 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4
            id={`peg-decision-market-heading-${asset.asset.asset}`}
            className="text-sm font-semibold text-white"
          >
            Decision market
          </h4>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            This is the market used to set the status above.
          </p>
        </div>
        <StatusPill
          label={usable ? (stale ? "Last confirmed" : "Usable") : "Unavailable"}
          tone={usable ? (stale ? "neutral" : "good") : "bad"}
        />
      </div>
      {source === null ? (
        <p className="mt-4 text-sm text-red-200">
          The configured decision market is missing from this check.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="break-words text-base font-semibold text-slate-100">
            {marketName(source)}
          </p>
          {usable ? (
            <SaleMeasurement source={source} nowMs={nowMs} stale={stale} />
          ) : (
            <p className="text-sm leading-6 text-amber-100">
              {sourceProblem(source, asset)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function safeguardState(
  monitor: PegMonitor,
  current: boolean,
  stale: boolean,
): { label: string; tone: "good" | "warn" | "bad" | "neutral"; text: string } {
  if (!current)
    return {
      label: "Check expired",
      tone: "warn",
      text: "The last trade safeguard result is too old to use.",
    };
  if (!monitor.indexedPoolReachable)
    return {
      label: "Pool unavailable",
      tone: "bad",
      text: stale
        ? "At the last confirmed check, pool data was unavailable."
        : "Pool data is unavailable, so this safety check cannot confirm current conditions.",
    };
  if (monitor.breaker === null)
    return {
      label: "Unavailable",
      tone: "bad",
      text: stale
        ? "The trade safeguard was unavailable at the last confirmed check."
        : "The trade safeguard could not be checked.",
    };
  if (!monitor.breaker.enabled)
    return {
      label: "Disabled",
      tone: "bad",
      text: stale
        ? "The trade safeguard was disabled at the last confirmed check."
        : "The trade safeguard is disabled.",
    };
  if (monitor.breaker.status === "TRIPPED")
    return {
      label: "Triggered",
      tone: "bad",
      text: stale
        ? "The trade safeguard was triggered at the last confirmed check."
        : "The trade safeguard has triggered.",
    };
  if (monitor.structuralQuerySaturated)
    return {
      label: "Check incomplete",
      tone: "warn",
      text: stale
        ? "At the last confirmed check, the pool query reached its result limit."
        : "The pool query reached its result limit, so this safety check is incomplete.",
    };
  if (stale)
    return {
      label: "Last confirmed",
      tone: "neutral",
      text: "At the last confirmed check, the trade safeguard was enabled and had not triggered.",
    };
  return {
    label: "Ready",
    tone: "good",
    text: "The trade safeguard is enabled and has not triggered.",
  };
}

type SafetyState = {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  text: string;
};

function poolCheckState(
  asset: PegAssetPresentation,
  structuralEvidenceCurrent: boolean,
  stale: boolean,
): SafetyState {
  const structural = asset.asset.structural;
  if (!structuralEvidenceCurrent)
    return {
      label: "Check expired",
      tone: "warn",
      text: "The last pool inflow check is too old to use.",
    };
  if (!structural.indexedPoolReachable)
    return {
      label: "Pool unavailable",
      tone: "bad",
      text: stale
        ? "At the last confirmed check, the indexed pool could not be reached."
        : "The indexed pool could not be reached.",
    };
  if (structural.structuralQuerySaturated)
    return {
      label: "Check incomplete",
      tone: "warn",
      text: stale
        ? "At the last confirmed check, the pool query reached its result limit."
        : "The pool query reached its result limit, so the inflow check is incomplete.",
    };

  const saturation = structural.structuralSaturation;
  const warnAt = formatFraction(asset.asset.policy.structuralWarnFraction);
  const text =
    saturation === null
      ? stale
        ? "At the last confirmed check, no active trading-limit window reported net inflow."
        : "No active trading-limit window is reporting net inflow."
      : stale
        ? `At the last confirmed check, net pool inflow was at ${formatFraction(saturation)} of the active on-chain trading limit. Warn at ${warnAt}.`
        : `Net pool inflow is at ${formatFraction(saturation)} of the active on-chain trading limit. Warn at ${warnAt}.`;
  const inflowWarning =
    saturation !== null &&
    saturation >= asset.asset.policy.structuralWarnFraction;
  if (stale)
    return inflowWarning
      ? { label: "Last confirmed warning", tone: "warn", text }
      : { label: "Last confirmed", tone: "neutral", text };
  return inflowWarning
    ? { label: "Inflow warning", tone: "warn", text }
    : { label: "Reachable", tone: "good", text };
}

function SafetyChecks({
  asset,
  stale,
}: {
  asset: PegAssetPresentation;
  stale: boolean;
}): React.JSX.Element {
  // Once a package is stale, this section describes what its confirmed
  // structural check found. Its age must not replace that result with a new,
  // synthetic expiry state while the user is reading retained evidence.
  const structuralEvidenceCurrent = stale || asset.structuralEvidenceCurrent;
  const poolState = poolCheckState(asset, structuralEvidenceCurrent, stale);
  return (
    <section
      data-testid={`peg-safety-checks-${asset.asset.asset}`}
      aria-labelledby={`peg-safety-checks-heading-${asset.asset.asset}`}
      className="rounded-lg border border-slate-800 bg-slate-950/35 p-4 lg:col-span-2"
    >
      <h4
        id={`peg-safety-checks-heading-${asset.asset.asset}`}
        className="text-sm font-semibold text-white"
      >
        Safety checks
      </h4>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        On-chain checks show whether the monitored pool is reachable, how close
        net inflow is to its active trading limit, and whether its trade
        safeguard is ready.
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        A trade safeguard problem makes this dashboard critical, but it does not
        page the on-call engineer by itself.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-800 bg-slate-900/45 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-medium text-slate-100">
              Pool inflow and reachability
            </p>
            <StatusPill label={poolState.label} tone={poolState.tone} />
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-300">
            {poolState.text}
          </p>
        </div>
        {asset.asset.monitors.map((monitor) => {
          const safeguard = safeguardState(
            monitor,
            structuralEvidenceCurrent,
            stale,
          );
          return (
            <div
              key={`${monitor.chainId}-${monitor.poolAddress}-${monitor.rateFeedId}-${monitor.monitoredTokenAddress}`}
              className="min-w-0 rounded-md border border-slate-800 bg-slate-900/45 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Link
                  href={`${buildPoolDetailHref(`${monitor.chainId}-${monitor.poolAddress}`)}?tab=oracle`}
                  title={monitor.poolAddress}
                  className="min-w-0 break-all font-mono text-sm font-medium text-indigo-400 hover:text-indigo-300"
                >
                  Pool {shortAddress(monitor.poolAddress)}
                </Link>
                <StatusPill label={safeguard.label} tone={safeguard.tone} />
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-300">
                {safeguard.text}
              </p>
            </div>
          );
        })}
      </div>
    </section>
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

function AssetEvidence({
  asset,
  nowMs,
  confirmedAtMs,
  stale,
  previousPolicy,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  confirmedAtMs: number;
  stale: boolean;
  previousPolicy: boolean;
}): React.JSX.Element {
  const retainedNotice = retainedCriticalNotice(asset, stale, previousPolicy);
  const notice = asset.currentCritical
    ? (asset.reasons[0] ??
      asset.uncertaintyReason ??
      "A critical monitoring condition is active.")
    : (retainedNotice ??
      (asset.uncertain || asset.tone === "warning"
        ? (asset.uncertaintyReason ?? asset.reasons[0])
        : null));
  return (
    <article
      className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5"
      aria-labelledby={`peg-evidence-heading-${asset.asset.asset}`}
    >
      <header>
        <h3
          id={`peg-evidence-heading-${asset.asset.asset}`}
          className="text-lg font-semibold text-white"
        >
          {asset.assetName} / {asset.asset.peg}
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          What determined this status
        </p>
      </header>
      {notice ? (
        <div
          role={asset.currentCritical ? "alert" : "status"}
          className={`rounded-lg border px-4 py-3 text-sm leading-6 ${
            asset.currentCritical
              ? "border-red-500/30 bg-red-950/30 text-red-100"
              : "border-amber-500/30 bg-amber-950/30 text-amber-100"
          }`}
        >
          {notice}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <DecisionMarket
          asset={asset}
          nowMs={nowMs}
          confirmedAtMs={confirmedAtMs}
          stale={stale}
        />
        <PegMonitoringAlertSettings asset={asset} />
        <SafetyChecks asset={asset} stale={stale} />
      </div>
      <OtherMarkets
        asset={asset}
        nowMs={nowMs}
        confirmedAtMs={confirmedAtMs}
        stale={stale}
      />
    </article>
  );
}

export function PegMonitoringEvidence({
  state,
  presentation,
  nowMs,
}: {
  state: ConfirmedState;
  presentation: PegMonitoringPresentation;
  nowMs: number;
}): React.JSX.Element {
  return (
    <details
      data-testid="peg-evidence-policy"
      className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/35"
    >
      <summary className="cursor-pointer px-4 py-4 sm:px-6">
        <span className="block text-lg font-semibold text-white">
          How this status was checked
        </span>
        <span className="mt-1 block max-w-3xl text-xs font-normal leading-5 text-slate-400">
          See the market check, alert settings, and safety checks behind this
          result.
        </span>
      </summary>
      <div className="min-w-0 space-y-5 border-t border-slate-800 p-4 sm:p-6">
        <CheckStatus state={state} />
        <PreviousPolicyNotice state={state} />
        {presentation.assets.map((asset) => (
          <AssetEvidence
            key={asset.asset.asset}
            asset={asset}
            nowMs={nowMs}
            confirmedAtMs={state.data.producedAt * 1_000}
            stale={state.kind === "stale"}
            previousPolicy={usesPreviousPolicy(state)}
          />
        ))}
        <PegMonitoringTechnicalRecord data={state.data} />
        <a
          href={PEG_GRAFANA_ALERTS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
        >
          View alert rules and history in Grafana ↗
        </a>
      </div>
    </details>
  );
}
