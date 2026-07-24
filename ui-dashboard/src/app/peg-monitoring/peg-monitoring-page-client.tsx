"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorBox } from "@/components/feedback";
import { usePegMonitoring } from "@/hooks/use-peg-monitoring";
import {
  PEG_GRAFANA_ALERTS_URL,
  classifyPegMonitoringState,
  type PegAssetPackage,
  type PegMonitor,
  type PegMonitoringResponse,
  type PegMonitoringViewState,
  type PegSource,
} from "@/lib/peg-monitoring";
import { buildPoolDetailHref } from "@/lib/routing";
import {
  EvidenceItem,
  StatusPill,
  formatAge,
  formatBps,
  formatFraction,
  formatNumber,
  formatScaled,
  formatUnixSeconds,
  shortAddress,
  titleCase,
} from "./peg-monitoring-evidence-primitives";

function Header(): React.JSX.Element {
  return (
    <header className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
          Incident evidence
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Peg monitoring
        </h1>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-slate-400">
        Current executable-price, market, structural, and breaker evidence from
        the Metrics Bridge decision package. Grafana remains authoritative for
        duration windows, coverage, pending and firing state, and history.
      </p>
      <a
        href={PEG_GRAFANA_ALERTS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
      >
        Open Peg Monitoring rules and history in Grafana ↗
      </a>
    </header>
  );
}
const LOADING_MONITOR_KEYS = ["t", "u", "v", "w", "x", "y", "z", "aa", "ab"];
const LOADING_SOURCE_KEYS = ["bitvavo-eur", "kraken-eur", "kraken-usd"];
const LOADING_SOURCE_EVIDENCE_KEYS = [
  "ac",
  "ad",
  "ae",
  "af",
  "ag",
  "ah",
  "ai",
  "aj",
  "ak",
  "al",
];
function LoadingMonitors(): React.JSX.Element {
  return (
    <section data-testid="peg-skeleton-monitors" className="space-y-3">
      <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
      <article className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/35 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="h-4 w-16 animate-pulse rounded bg-slate-800" />
            <div className="h-5 w-36 animate-pulse rounded bg-slate-800" />
          </div>
          <div className="h-7 w-24 animate-pulse rounded-full bg-slate-800" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {LOADING_MONITOR_KEYS.map((key) => (
            <div
              key={key}
              className={`${key === "ab" ? "h-16" : "h-24"} animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40`}
            />
          ))}
        </div>
      </article>
    </section>
  );
}
function LoadingSources(): React.JSX.Element {
  return (
    <section data-testid="peg-skeleton-sources" className="space-y-3">
      <div className="h-5 w-44 animate-pulse rounded bg-slate-800" />
      {LOADING_SOURCE_KEYS.map((sourceKey) => (
        <article
          key={sourceKey}
          className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/35 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
              <div className="h-4 w-52 animate-pulse rounded bg-slate-800" />
            </div>
            <div className="h-7 w-44 animate-pulse rounded-full bg-slate-800" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {LOADING_SOURCE_EVIDENCE_KEYS.map((key) => (
              <div
                key={`${sourceKey}-${key}`}
                className="h-20 animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40"
              />
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
function Loading(): React.JSX.Element {
  return (
    <section aria-label="Loading peg monitoring" className="space-y-6">
      <div
        data-testid="peg-skeleton-status"
        className="h-12 animate-pulse rounded-lg border border-slate-800 bg-slate-900/45"
      />
      <div data-testid="peg-skeleton-snapshot" className="space-y-3">
        <div className="h-7 w-28 animate-pulse rounded bg-slate-800" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {["a", "b", "c", "d", "e"].map((key) => (
            <div
              key={key}
              className="h-28 animate-pulse rounded-md border border-slate-800 bg-slate-950/40"
            />
          ))}
        </div>
      </div>
      <div
        data-testid="peg-skeleton-package"
        className="space-y-6 rounded-xl border border-slate-800 bg-slate-900/45 p-4 sm:p-6"
      >
        <div
          data-testid="peg-skeleton-package-header"
          className="flex flex-wrap items-start justify-between gap-4"
        >
          <div className="h-12 w-1/3 animate-pulse rounded bg-slate-800" />
        </div>
        <section data-testid="peg-skeleton-structural" className="space-y-3">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-800" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            {["f", "g", "h", "i", "j", "k"].map((key) => (
              <div
                key={key}
                className="h-20 animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40"
              />
            ))}
          </div>
        </section>
        <section data-testid="peg-skeleton-policy" className="space-y-3">
          <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {["l", "m", "n", "o", "p", "q", "r", "s"].map((key) => (
              <div
                key={key}
                className="h-20 animate-pulse rounded-md border border-slate-800/80 bg-slate-950/40"
              />
            ))}
          </div>
        </section>
        <LoadingMonitors />
        <LoadingSources />
      </div>
    </section>
  );
}
function SnapshotStatus({
  state,
}: {
  state: Extract<PegMonitoringViewState, { kind: "current" | "stale" }>;
}): React.JSX.Element {
  if (state.kind === "current")
    return (
      <div
        data-testid="peg-status"
        role="status"
        className="rounded-lg border border-emerald-500/20 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200"
      >
        Current package · produced {formatAge(state.ageMs)} ago
      </div>
    );
  const why = {
    age: "The producer timestamp is older than the 90-second freshness window.",
    "clock-skew": "The producer timestamp is ahead of this browser clock.",
    "refresh-error": "The latest dashboard refresh failed.",
  }[state.reason];
  return (
    <div
      data-testid="peg-status"
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-950/40 px-4 py-3 text-sm text-amber-100"
    >
      <span className="font-semibold">Stale — last confirmed package.</span>{" "}
      {why} Produced {formatAge(state.ageMs)} ago; retained evidence is not
      presented as current.
    </div>
  );
}
function Snapshot({
  data,
}: {
  data: PegMonitoringResponse;
}): React.JSX.Element {
  const previous =
    data.policySlot === "previous" ||
    data.producedPolicyVersion !== data.approvedActivePolicyVersion;
  return (
    <section
      data-testid="peg-snapshot"
      aria-labelledby="snapshot-heading"
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="snapshot-heading" className="text-lg font-semibold text-white">
          Snapshot
        </h2>
        <StatusPill
          label={previous ? "Previous-policy fallback" : "Active policy"}
          tone={previous ? "warn" : "good"}
        />
      </div>
      {previous ? (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
        >
          The approved active policy is not the policy used for this complete
          package. Review rollover state before acting.
        </div>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <EvidenceItem
          label="Produced"
          value={formatUnixSeconds(data.producedAt)}
        />
        <EvidenceItem
          label="Approved active"
          value={data.approvedActivePolicyVersion}
        />
        <EvidenceItem
          label="Produced policy"
          value={data.producedPolicyVersion}
          detail={`slot: ${data.policySlot}`}
        />
        <EvidenceItem label="Schema" value={`v${data.schemaVersion}`} />
        <EvidenceItem
          label="Rollover acknowledgement"
          value={`${data.rolloverAckExpectedSeconds}s expected`}
        />
      </dl>
    </section>
  );
}
function Structural({ item }: { item: PegAssetPackage }): React.JSX.Element {
  const value = item.structural;
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-200">
        Structural evidence
      </h3>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <EvidenceItem
          label="Blind"
          value={value.blind ? "Yes" : "No"}
          detail="Current package flag"
        />
        <EvidenceItem
          label="Blind consecutive polls"
          value={String(value.blindConsecutivePolls)}
          detail={`threshold ${item.policy.blindConsecutivePolls}`}
        />
        <EvidenceItem
          label="Saturation"
          value={formatFraction(value.structuralSaturation)}
        />
        <EvidenceItem
          label="Query saturated"
          value={value.structuralQuerySaturated ? "Yes" : "No"}
        />
        <EvidenceItem
          label="Indexed pool reachable"
          value={value.indexedPoolReachable ? "Yes" : "No"}
        />
        <EvidenceItem
          label="Counterparties"
          value={String(value.counterpartyCount)}
          detail="Advisory unique count"
        />
      </dl>
    </section>
  );
}
function Policy({ item }: { item: PegAssetPackage }): React.JSX.Element {
  const value = item.policy;
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-200">
        Produced policy context
      </h3>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <EvidenceItem label="Target" value={formatNumber(value.target)} />
        <EvidenceItem
          label="Downside warning"
          value={formatBps(value.warnDeviationBps)}
          detail={`${value.warnSustainSeconds}s sustain`}
        />
        <EvidenceItem
          label="Downside critical"
          value={formatBps(value.criticalDeviationBps)}
          detail={`${value.criticalSustainSeconds}s sustain`}
        />
        <EvidenceItem
          label="Premium warning"
          value={formatBps(value.premiumWarnBps)}
        />
        <EvidenceItem
          label="Structural warning"
          value={formatFraction(value.structuralWarnFraction)}
        />
        <EvidenceItem
          label="Duration quantile"
          value={formatFraction(value.durationQuantile)}
          detail={`${formatFraction(value.minimumCoverageFraction)} minimum coverage`}
        />
        <EvidenceItem
          label="Blindness threshold"
          value={`${value.blindConsecutivePolls} consecutive polls`}
          detail={`${value.permanentlyDeadSeconds}s permanently dead`}
        />
        <EvidenceItem
          label="Deep venue"
          value={value.deepVenueSource}
          detail={`${value.freshnessGraceSeconds}s freshness grace`}
        />
      </dl>
    </section>
  );
}
function Monitor({ monitor }: { monitor: PegMonitor }): React.JSX.Element {
  const b = monitor.breaker;
  const tone =
    b === null
      ? "neutral"
      : !b.enabled || b.status === "TRIPPED"
        ? "bad"
        : "good";
  const label =
    b === null ? "Breaker unavailable" : !b.enabled ? "Disabled" : b.status;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">Chain {monitor.chainId}</p>
          <Link
            href={`${buildPoolDetailHref(`${monitor.chainId}-${monitor.poolAddress}`)}?tab=oracle`}
            className="mt-1 inline-flex font-mono text-sm text-indigo-400 hover:text-indigo-300"
            title={monitor.poolAddress}
          >
            Pool {shortAddress(monitor.poolAddress)}
          </Link>
        </div>
        <StatusPill label={label} tone={tone} />
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <EvidenceItem
          label="Rate feed"
          value={shortAddress(monitor.rateFeedId)}
          detail={monitor.rateFeedId}
        />
        <EvidenceItem
          label="Monitored token"
          value={shortAddress(monitor.monitoredTokenAddress)}
          detail={monitor.monitoredTokenAddress}
        />
        <EvidenceItem
          label="Pool reachable"
          value={monitor.indexedPoolReachable ? "Yes" : "No"}
        />
        <EvidenceItem
          label="Structural saturation"
          value={formatFraction(monitor.structuralSaturation)}
          detail={`${monitor.counterpartyCount} advisory counterparties`}
        />
        {b ? (
          <>
            <EvidenceItem
              label="Breaker"
              value={`${b.enabled ? "Enabled" : "Disabled"} · ${b.kind} · mode ${b.tradingMode}`}
              detail={`Reported status ${b.status} · ${b.id}`}
            />
            <EvidenceItem
              label="Effective threshold"
              value={`${formatScaled(b.effectiveRateChangeThreshold, 20)} bps`}
              detail={`${b.effectiveRateChangeThreshold} raw`}
            />
            <EvidenceItem
              label="Reference value"
              value={formatScaled(b.referenceValue, 24)}
            />
            <EvidenceItem
              label="Last median rate"
              value={formatScaled(b.lastMedianRate, 24)}
            />
            <EvidenceItem
              label="Breaker timestamps"
              value={formatUnixSeconds(b.lastStatusUpdatedAt)}
              detail={`value updated ${formatUnixSeconds(b.lastUpdatedAt)}`}
            />
          </>
        ) : null}
      </dl>
    </article>
  );
}
function Source({ source }: { source: PegSource }): React.JSX.Element {
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-medium text-white">
            {source.provider} · {source.pair}
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            {source.id} · {source.registryRole} role · {source.authority}{" "}
            authority
          </p>
        </div>
        <div className="flex gap-2">
          <StatusPill
            label={source.healthy ? "Healthy" : "Unhealthy"}
            tone={source.healthy ? "good" : "bad"}
          />
          <StatusPill
            label={`Listing: ${titleCase(source.listingState)}`}
            tone={
              source.listingState === "listed"
                ? "good"
                : source.listingState === null
                  ? "neutral"
                  : "warn"
            }
          />
        </div>
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <EvidenceItem
          label="Executable price"
          value={formatNumber(source.executablePrice)}
        />
        <EvidenceItem
          label="Reference / fill"
          value={`${source.referenceSize === null ? "—" : formatNumber(source.referenceSize)} / ${formatFraction(source.filledFraction)}`}
          detail={`capped: ${source.capped === null ? "—" : source.capped ? "Yes" : "No"}`}
        />
        <EvidenceItem
          label="Bid / ask"
          value={`${formatNumber(source.bid)} / ${formatNumber(source.ask)}`}
        />
        <EvidenceItem label="Spread" value={formatBps(source.spreadBps)} />
        <EvidenceItem
          label="Downside / premium"
          value={`${formatBps(source.deviationBps)} / ${formatBps(source.premiumBps)}`}
        />
        <EvidenceItem
          label="Venue state"
          value={titleCase(source.venueState)}
        />
        <EvidenceItem
          label="Observation"
          value={formatUnixSeconds(source.observationAt)}
          detail={`fetched ${formatUnixSeconds(source.fetchedAt)}`}
        />
        <EvidenceItem
          label="Last trade"
          value={formatUnixSeconds(source.lastTradeAt)}
        />
        <EvidenceItem
          label="Listing checked"
          value={formatUnixSeconds(source.listingCheckedAt)}
          detail="Last authoritative result"
        />
        <EvidenceItem
          label="Source policy"
          value={`${source.policy.pollIntervalSeconds}s poll · ${source.policy.staleAfterSeconds}s stale`}
        />
      </dl>
    </article>
  );
}
function Package({
  item,
  index,
}: {
  item: PegAssetPackage;
  index: number;
}): React.JSX.Element {
  const heading = `peg-asset-${index}`;
  return (
    <article
      data-testid={`peg-package-${index}`}
      aria-labelledby={heading}
      className="space-y-6 rounded-xl border border-slate-800 bg-slate-900/45 p-4 sm:p-6"
    >
      <header
        data-testid={`peg-package-${index}-header`}
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div>
          <h2 id={heading} className="text-xl font-semibold text-white">
            {item.asset} / {item.peg}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {item.coverageClass} · {item.sources.length} sources ·{" "}
            {item.monitors.length} monitors
          </p>
        </div>
      </header>
      <div data-testid={`peg-package-${index}-structural`}>
        <Structural item={item} />
      </div>
      <div data-testid={`peg-package-${index}-policy`}>
        <Policy item={item} />
      </div>
      <section
        data-testid={`peg-package-${index}-monitors`}
        className="space-y-3"
      >
        <h3 className="text-sm font-semibold text-slate-200">
          Pool and breaker evidence
        </h3>
        {item.monitors.map((monitor) => (
          <Monitor
            key={`${monitor.chainId}-${monitor.poolAddress}-${monitor.rateFeedId}-${monitor.monitoredTokenAddress}`}
            monitor={monitor}
          />
        ))}
      </section>
      <section
        data-testid={`peg-package-${index}-sources`}
        className="space-y-3"
      >
        <h3 className="text-sm font-semibold text-slate-200">
          Market-source evidence
        </h3>
        {item.sources.map((source) => (
          <Source key={source.id} source={source} />
        ))}
      </section>
    </article>
  );
}
export function PegMonitoringPageClient(): React.JSX.Element {
  const result = usePegMonitoring();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const state = classifyPegMonitoringState({
    ...result,
    nowMs: Math.max(now, Date.now()),
  });
  return (
    <div data-testid="peg-monitoring-page" className="space-y-8">
      <Header />
      {state.kind === "loading" ? (
        <Loading />
      ) : state.kind === "unavailable" ? (
        <ErrorBox message="Peg monitoring is unavailable. No confirmed decision package can be shown." />
      ) : (
        <div className="space-y-6">
          <SnapshotStatus state={state} />
          <Snapshot data={state.data} />
          <div className="space-y-5">
            {state.data.packages.map((item, index) => (
              <Package key={item.asset} item={item} index={index} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
