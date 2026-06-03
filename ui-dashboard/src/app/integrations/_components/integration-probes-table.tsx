import { Table, Td, Th } from "@/components/table";
import type {
  IntegrationProbeAggregator,
  IntegrationProbeChain,
  IntegrationProbeSnapshot,
} from "@/lib/integration-probes";
import { IntegrationStatusBadge } from "./integration-status-badge";

const CHAIN_ORDER = [42220, 143];

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
        <td colSpan={6} className="px-2 sm:px-4 py-2">
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
  if (pair.sourceLabels.length > 0) {
    return `label only: ${pair.sourceLabels.join(", ")}`;
  }
  return pair.error ?? pair.downstreamProvider ?? "no address evidence";
}

function metaText(pair: IntegrationProbeChain["pairs"][number]): string {
  const parts = [
    pair.httpStatus === null ? null : `HTTP ${pair.httpStatus}`,
    pair.latencyMs === null ? null : `${pair.latencyMs}ms`,
    pair.downstreamProvider ? `provider ${pair.downstreamProvider}` : null,
    pair.routeVariant ? `variant ${pair.routeVariant}` : null,
    pair.routeAmountUsd ? `amount ${pair.routeAmountUsd}` : null,
    pair.attemptCount && pair.attemptCount > 1
      ? `${pair.attemptCount} attempts`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" | ") : "quote not requested";
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
