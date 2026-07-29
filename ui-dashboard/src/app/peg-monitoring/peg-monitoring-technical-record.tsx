import Link from "next/link";
import type {
  PegAssetPackage,
  PegMonitor,
  PegMonitoringResponse,
  PegSource,
} from "@/lib/peg-monitoring";
import { buildPoolDetailHref } from "@/lib/routing";
import {
  EvidenceItem,
  StatusPill,
  formatBps,
  formatFraction,
  formatNumber,
  formatScaled,
  formatUnixSeconds,
  shortAddress,
  titleCase,
} from "./peg-monitoring-evidence-primitives";

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
        <h3
          id="snapshot-heading"
          className="text-base font-semibold text-white"
        >
          Package details
        </h3>
        <StatusPill
          label={previous ? "Previous alert policy" : "Current alert policy"}
          tone={previous ? "warn" : "good"}
        />
      </div>
      {previous ? (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
        >
          This complete package used the previous approved alert policy. Check
          the policy update before acting on these technical values.
        </div>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <EvidenceItem
          label="Produced"
          value={formatUnixSeconds(data.producedAt)}
        />
        <EvidenceItem
          label="Approved policy"
          value={data.approvedActivePolicyVersion}
        />
        <EvidenceItem
          label="Policy used"
          value={data.producedPolicyVersion}
          detail={`slot: ${data.policySlot}`}
        />
        <EvidenceItem label="Schema" value={`v${data.schemaVersion}`} />
        <EvidenceItem
          label="Policy change window"
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
      <h4 className="text-sm font-semibold text-slate-200">Pool checks</h4>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <EvidenceItem
          label="Full-size price unavailable"
          value={value.blind ? "Yes" : "No"}
          detail="Current package flag"
        />
        <EvidenceItem
          label="Consecutive failed full-size price checks"
          value={String(value.blindConsecutivePolls)}
          detail={`threshold ${item.policy.blindConsecutivePolls}`}
        />
        <EvidenceItem
          label="Net inflow vs active trading limit"
          value={formatFraction(value.structuralSaturation)}
        />
        <EvidenceItem
          label="Pool query reached its limit"
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
      <h4 className="text-sm font-semibold text-slate-200">
        Alert policy details
      </h4>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <EvidenceItem label="Target" value={formatNumber(value.target)} />
        <EvidenceItem
          label="Downside warning"
          value={formatBps(value.warnDeviationBps)}
          detail={`${value.warnSustainSeconds}s window`}
        />
        <EvidenceItem
          label="Downside critical"
          value={formatBps(value.criticalDeviationBps)}
          detail={`${value.criticalSustainSeconds}s window`}
        />
        <EvidenceItem
          label="Premium warning"
          value={formatBps(value.premiumWarnBps)}
        />
        <EvidenceItem
          label="Pool inflow warning"
          value={formatFraction(value.structuralWarnFraction)}
        />
        <EvidenceItem
          label="Duration quantile"
          value={formatFraction(value.durationQuantile)}
          detail={`${formatFraction(value.minimumCoverageFraction)} minimum coverage`}
        />
        <EvidenceItem
          label="Missing-price threshold"
          value={`${value.blindConsecutivePolls} consecutive checks`}
          detail={`${value.permanentlyDeadSeconds}s permanently dead`}
        />
        <EvidenceItem
          label="Decision market ID"
          value={value.deepVenueSource}
          detail={`${value.freshnessGraceSeconds}s pool-check freshness`}
        />
      </dl>
    </section>
  );
}

function Monitor({ monitor }: { monitor: PegMonitor }): React.JSX.Element {
  const breaker = monitor.breaker;
  const tone =
    breaker === null
      ? "neutral"
      : !breaker.enabled || breaker.status === "TRIPPED"
        ? "bad"
        : "good";
  const label =
    breaker === null
      ? "Safeguard unavailable"
      : !breaker.enabled
        ? "Disabled"
        : breaker.status;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-400">Chain {monitor.chainId}</p>
          <Link
            href={`${buildPoolDetailHref(`${monitor.chainId}-${monitor.poolAddress}`)}?tab=oracle`}
            className="mt-1 inline-flex break-all font-mono text-sm text-indigo-400 hover:text-indigo-300"
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
          label="Net inflow vs active trading limit"
          value={formatFraction(monitor.structuralSaturation)}
          detail={`${monitor.counterpartyCount} advisory counterparties`}
        />
        <EvidenceItem
          label="Pool query result"
          value={
            monitor.structuralQuerySaturated
              ? "Partial — result limit reached"
              : "Complete within page limit"
          }
          detail={
            monitor.structuralQuerySaturated
              ? "The bounded companion query may be incomplete"
              : "No bounded-query truncation reported"
          }
        />
        {breaker ? (
          <>
            <EvidenceItem
              label="Trade safeguard"
              value={`${breaker.enabled ? "Enabled" : "Disabled"} · ${breaker.kind} · mode ${breaker.tradingMode}`}
              detail={`Breaker status ${breaker.status} · ${breaker.id}`}
            />
            <EvidenceItem
              label="Effective threshold"
              value={`${formatScaled(breaker.effectiveRateChangeThreshold, 20)} bps`}
              detail={`${breaker.effectiveRateChangeThreshold} raw`}
            />
            <EvidenceItem
              label="Reference value"
              value={formatScaled(breaker.referenceValue, 24)}
            />
            <EvidenceItem
              label="Last median rate"
              value={formatScaled(breaker.lastMedianRate, 24)}
            />
            <EvidenceItem
              label="Safeguard timestamps"
              value={formatUnixSeconds(breaker.lastStatusUpdatedAt)}
              detail={`value updated ${formatUnixSeconds(breaker.lastUpdatedAt)}`}
            />
          </>
        ) : null}
      </dl>
    </article>
  );
}

function Source({ source }: { source: PegSource }): React.JSX.Element {
  const listingLabel =
    source.listingState === "listed"
      ? "Trading listed"
      : source.listingState === "halted"
        ? "Trading halted"
        : source.listingState === "absent"
          ? "Trading absent"
          : "Trading status unknown";
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="break-words font-medium text-white">
            {source.provider} · {source.pair}
          </h5>
          <p className="mt-1 break-words text-xs text-slate-400">
            {source.id} · use: {source.registryRole} · authority:{" "}
            {source.authority}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill
            label={source.healthy ? "Healthy" : "Unhealthy"}
            tone={source.healthy ? "good" : "bad"}
          />
          <StatusPill
            label={listingLabel}
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
          label="Test trade size / filled"
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
          label="Market condition"
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
          label="Trading availability checked"
          value={formatUnixSeconds(source.listingCheckedAt)}
          detail="Last authoritative result"
        />
        <EvidenceItem
          label="Source timing"
          value={`${source.policy.pollIntervalSeconds}s poll · ${source.policy.staleAfterSeconds}s stale · missing after ${source.policy.listingAbsentConsecutiveChecks} checks`}
          detail={
            source.convertVia
              ? `Price conversion: ${source.convertVia.fromCurrency} → ${source.convertVia.toCurrency} via feed ${shortAddress(source.convertVia.rateFeedId)} · chain ${source.convertVia.chainId}`
              : undefined
          }
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
  const heading = `peg-technical-asset-${index}`;
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
          <h3 id={heading} className="text-lg font-semibold text-white">
            {item.asset} / {item.peg}
          </h3>
          <p className="mt-1 text-xs text-slate-400">
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
        <h4 className="text-sm font-semibold text-slate-200">
          Pool and safeguard details
        </h4>
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
        <h4 className="text-sm font-semibold text-slate-200">
          Market check details
        </h4>
        {item.sources.map((source) => (
          <Source key={source.id} source={source} />
        ))}
      </section>
    </article>
  );
}

export function PegMonitoringTechnicalRecord({
  data,
}: {
  data: PegMonitoringResponse;
}): React.JSX.Element {
  return (
    <details
      data-testid="peg-technical-record"
      className="rounded-lg border border-slate-800 bg-slate-950/40"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-200 hover:text-white">
        Technical record
      </summary>
      <div className="space-y-5 border-t border-slate-800 p-4">
        <p className="max-w-3xl text-xs leading-5 text-slate-400">
          Version IDs, raw measurements, source timing, addresses, and safeguard
          values for investigation.
        </p>
        <Snapshot data={data} />
        {data.packages.map((item, index) => (
          <Package key={item.asset} item={item} index={index} />
        ))}
      </div>
    </details>
  );
}
