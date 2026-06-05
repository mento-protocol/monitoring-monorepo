import { Table, Td, Th } from "@/components/table";
import type {
  IntegrationProbeAggregator,
  IntegrationProbeChain,
  IntegrationProbeSnapshot,
} from "@/lib/integration-probes";
import { IntegrationStatusBadge } from "./integration-status-badge";

const CHAIN_ORDER = [42220, 143];
const PREVIEW_VENUE_KEYS = [
  "dex",
  "tool",
  "toolName",
  "provider",
  "protocol",
  "source",
  "providerType",
] as const;

export function IntegrationProbesTable({
  snapshot,
}: {
  snapshot: IntegrationProbeSnapshot;
}) {
  return (
    <Table aria-label="Mento v3 aggregator integration health">
      <thead>
        <tr className="border-b border-slate-800 bg-slate-950/40">
          <Th>Aggregator</Th>
          <Th>Tier</Th>
          <Th>Type</Th>
          <Th>Volume Signal</Th>
          <Th>Celo</Th>
          <Th>Monad</Th>
          <Th>Next Step</Th>
        </tr>
      </thead>
      <tbody>
        {snapshot.aggregators.map((aggregator) => (
          <AggregatorRows key={aggregator.id} aggregator={aggregator} />
        ))}
      </tbody>
    </Table>
  );
}

function AggregatorRows({
  aggregator,
}: {
  aggregator: IntegrationProbeAggregator;
}) {
  const chainsById = new Map(
    aggregator.chains.map((chain) => [chain.chainId, chain]),
  );
  const nextStep =
    aggregator.chains.find((chain) => chain.nextStep)?.nextStep ??
    aggregator.researchNote;
  return (
    <>
      <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
        <Td>
          <div className="min-w-[9rem]">
            <div className="font-medium text-white">{aggregator.label}</div>
            {aggregator.credentialEnv.length > 0 && (
              <div className="mt-1 text-[10px] text-slate-500">
                {aggregator.credentialEnv.join(", ")}
              </div>
            )}
          </div>
        </Td>
        <Td mono>{String(aggregator.tier)}</Td>
        <Td>{kindLabel(aggregator.kind)}</Td>
        <Td>
          <VolumeSignalCell signal={aggregator.volumeSignal} />
        </Td>
        {CHAIN_ORDER.map((chainId) => (
          <Td key={chainId}>
            <ChainCell chain={chainsById.get(chainId)} />
          </Td>
        ))}
        <Td muted small>
          <span className="block max-w-[18rem] whitespace-normal">
            {nextStep ?? "-"}
          </span>
        </Td>
      </tr>
      <tr className="border-b border-slate-800/50 bg-slate-950/30">
        <td colSpan={7} className="px-2 sm:px-4 py-2">
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-indigo-300">
              Pair evidence
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {aggregator.chains.map((chain) => (
                <ChainEvidence key={chain.chainId} chain={chain} />
              ))}
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

function VolumeSignalCell({
  signal,
}: {
  signal: IntegrationProbeAggregator["volumeSignal"];
}) {
  if (!signal) return <span className="text-slate-500">-</span>;
  const category = volumeCategoryLabel(signal.category);
  if (signal.valueUsd === null) {
    return (
      <div className="max-w-[11rem]" title={signal.note ?? undefined}>
        <div className="font-mono text-xs text-slate-500">-</div>
        <div className="mt-1 text-[10px] text-slate-500">
          {category} · unavailable
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[11rem]" title={volumeTitle(signal)}>
      <div className="font-mono text-xs text-slate-200">
        {formatUsdCompact(signal.valueUsd)} {signal.window}
      </div>
      <div className="mt-1 text-[10px] text-slate-500">
        {category} · {volumeSourceLabel(signal)}
      </div>
    </div>
  );
}

function ChainCell({ chain }: { chain?: IntegrationProbeChain | undefined }) {
  if (!chain) return <span className="text-slate-500">-</span>;
  return (
    <div className="space-y-1">
      <IntegrationStatusBadge status={chain.status} />
      <div className="text-[10px] text-slate-500">
        {chain.pairCoverage.passed}/{chain.pairCoverage.total} routes
      </div>
    </div>
  );
}

function ChainEvidence({ chain }: { chain: IntegrationProbeChain }) {
  const visiblePairs = prioritizedPairs(chain.pairs).slice(0, 12);
  const hiddenCount = Math.max(0, chain.pairs.length - visiblePairs.length);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{chain.chainLabel}</h3>
        <IntegrationStatusBadge status={chain.status} />
      </div>
      <div className="space-y-2">
        {visiblePairs.map((pair) => (
          <div
            key={`${pair.pairId}-${pair.direction}`}
            className="rounded border border-slate-800/70 bg-slate-950/40 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-200">
                {pair.sellSymbol} -&gt; {pair.buySymbol}
              </span>
              <IntegrationStatusBadge status={pair.status} />
            </div>
            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">
              {evidenceText(pair)}
            </p>
            <p className="mt-1 text-[10px] text-slate-500">{metaText(pair)}</p>
          </div>
        ))}
        {hiddenCount > 0 && (
          <p className="text-xs text-slate-500">
            {hiddenCount} more route checks in the snapshot.
          </p>
        )}
      </div>
    </div>
  );
}

function volumeTitle(
  signal: NonNullable<IntegrationProbeAggregator["volumeSignal"]>,
): string {
  return [signal.sourceLabel, signal.sourceProtocol, signal.note]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

function volumeSourceLabel(
  signal: NonNullable<IntegrationProbeAggregator["volumeSignal"]>,
): string {
  return signal.sourceLabel.startsWith("DefiLlama")
    ? "DefiLlama"
    : signal.sourceLabel;
}

function volumeCategoryLabel(
  category: NonNullable<IntegrationProbeAggregator["volumeSignal"]>["category"],
): string {
  switch (category) {
    case "bridge-aggregator":
      return "Bridge agg";
    case "dex-aggregator":
      return "DEX agg";
    case "direct-bridge":
      return "Direct bridge";
    case "official-stats":
      return "Official stats";
  }
}

function formatUsdCompact(value: number): string {
  const units = [
    { divisor: 1_000_000_000, suffix: "B" },
    { divisor: 1_000_000, suffix: "M" },
    { divisor: 1_000, suffix: "K" },
  ] as const;
  const match = units.find((unit) => Math.abs(value) >= unit.divisor);
  if (!match) return `$${Math.round(value).toLocaleString("en-US")}`;
  const scaled = value / match.divisor;
  const formatted = scaled.toFixed(1);
  return `$${formatted.replace(/\.0$/, "")}${match.suffix}`;
}

function prioritizedPairs(
  pairs: IntegrationProbeChain["pairs"],
): IntegrationProbeChain["pairs"] {
  return [...pairs].sort((left, right) => {
    const leftPriority = left.status === "pass" ? 1 : 0;
    const rightPriority = right.status === "pass" ? 1 : 0;
    return leftPriority - rightPriority;
  });
}

function evidenceText(pair: IntegrationProbeChain["pairs"][number]): string {
  if (pair.evidence.length > 0) {
    return pair.evidence
      .map((item) => `${item.type}: ${item.value}`)
      .join(" | ");
  }
  if (pair.status === "fail") {
    const venue = selectedVenue(pair);
    const parts = [
      "no Mento v3 router/pool address evidence",
      venue ? `selected venue: ${venue}` : null,
      pair.txTarget ? `tx target: ${pair.txTarget}` : null,
      pair.sourceLabels.length > 0
        ? `labels: ${pair.sourceLabels.join(", ")}`
        : null,
    ].filter((part): part is string => part !== null);
    return parts.join("; ");
  }
  if (pair.error) return pair.error;
  if (pair.sourceLabels.length > 0) {
    return `label only: ${pair.sourceLabels.join(", ")}`;
  }
  return selectedVenue(pair) ?? "no address evidence";
}

function metaText(pair: IntegrationProbeChain["pairs"][number]): string {
  const venue = selectedVenue(pair);
  const parts = [
    pair.httpStatus === null ? null : `HTTP ${pair.httpStatus}`,
    pair.latencyMs === null ? null : `${pair.latencyMs}ms`,
    venue ? `venue ${venue}` : null,
    pair.routeVariant ? `variant ${pair.routeVariant}` : null,
    pair.routeAmountUsd ? `amount ${pair.routeAmountUsd}` : null,
    pair.attemptCount && pair.attemptCount > 1
      ? `${pair.attemptCount} attempts`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" | ") : "quote not requested";
}

function selectedVenue(
  pair: IntegrationProbeChain["pairs"][number],
): string | null {
  if (
    pair.downstreamProvider &&
    !isSourceOnlyVenue(pair, pair.downstreamProvider)
  ) {
    return pair.downstreamProvider;
  }
  return venueFromPreview(pair);
}

function venueFromPreview(
  pair: IntegrationProbeChain["pairs"][number],
): string | null {
  const preview = pair.responsePreview;
  if (!preview) return null;
  for (const key of PREVIEW_VENUE_KEYS) {
    const venue = previewVenueValue(preview, key);
    if (!venue || isSourceOnlyVenue(pair, venue)) continue;
    return venue;
  }
  return null;
}

function previewVenueValue(preview: string, key: string): string | null {
  const match = preview.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

function isSourceOnlyVenue(
  pair: IntegrationProbeChain["pairs"][number],
  venue: string,
): boolean {
  return pair.status === "fail" && pair.sourceLabels.includes(venue);
}

function kindLabel(kind: IntegrationProbeAggregator["kind"]): string {
  switch (kind) {
    case "cross_chain":
      return "Cross-chain";
    case "dex":
      return "DEX";
    case "meta":
      return "Meta";
    case "excluded":
      return "Excluded";
  }
}
