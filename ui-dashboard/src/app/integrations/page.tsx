import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import {
  getIntegrationProbeSnapshot,
  type IntegrationProbeSnapshot,
} from "@/lib/integration-probes";
import { IntegrationProbesTable } from "./_components/integration-probes-table";

// Signed-in-only page (see middleware + the in-page guard below). Auth is
// per-request, so this can't be ISR-cached — `force-dynamic` instead of the
// previous `revalidate = 60`, matching the entities page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Aggregator Integrations | Mento Analytics",
  description:
    "Quote-based Mento v3 integration health for aggregators and cross-chain routers.",
};

export default async function IntegrationsPage() {
  // Defense-in-depth: middleware already redirects unauthenticated users to
  // /sign-in, but guard in-route too rather than trusting the matcher alone.
  const session = await getAuthSession();
  if (!session?.user?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN)) notFound();

  const { snapshot, error } = await getIntegrationProbeSnapshot();
  const nowMs = Date.now();
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium text-indigo-300">
          Aggregator Integrations
        </p>
        <h1 className="text-2xl font-semibold text-white">
          Mento v3 route coverage
        </h1>
      </header>

      {error && (
        <ErrorBox message={`Integration probes unavailable: ${error}`} />
      )}

      {snapshot ? (
        <IntegrationsContent snapshot={snapshot} nowMs={nowMs} />
      ) : error ? null : (
        <EmptyBox message="No integration probe snapshot has been published yet." />
      )}
    </div>
  );
}

function IntegrationsContent({
  nowMs,
  snapshot,
}: {
  nowMs: number;
  snapshot: IntegrationProbeSnapshot;
}) {
  return (
    <>
      {snapshotIsStale(snapshot.generatedAt, nowMs) && (
        <div
          role="alert"
          className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300"
        >
          Snapshot is stale: last successful probe run was{" "}
          {formatSnapshotTime(snapshot.generatedAt)}. Probes run daily at 06:17
          UTC; check the Integration Probes workflow and aggregator API keys.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Tile
          label="Aggregators"
          value={String(snapshot.summary.aggregators)}
        />
        <Tile
          label="Passing"
          value={`${snapshot.summary.passingChainChecks}/${snapshot.summary.chainChecks}`}
          subtitle="chain checks"
        />
        <Tile
          label="Partial"
          value={String(snapshot.summary.partialChainChecks)}
          subtitle="some routes pass"
        />
        <Tile
          label="Needs Key"
          value={String(snapshot.summary.needsKeyChainChecks)}
        />
        <Tile
          label="Last Run"
          value={formatSnapshotTime(snapshot.generatedAt)}
          subtitle={snapshot.pairSource.kind}
        />
      </div>

      <section aria-labelledby="integrations-heading" className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="integrations-heading"
              className="text-lg font-semibold text-white"
            >
              Route checks
            </h2>
            <p className="text-sm text-slate-400">
              Default {snapshot.amountUsd} stable unit per direction;{" "}
              {snapshot.pairSource.note}
            </p>
          </div>
          <p className="text-xs text-muted">
            Taker {shortAddress(snapshot.takerAddress)}
          </p>
        </div>
        <IntegrationProbesTable snapshot={snapshot} />
      </section>
    </>
  );
}

// Probes run daily at 06:17 UTC in integration-probes.yml; this is 2x cadence.
const SNAPSHOT_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function snapshotIsStale(generatedAt: string, nowMs: number): boolean {
  const generated = new Date(generatedAt).getTime();
  if (Number.isNaN(generated)) return true;
  return nowMs - generated > SNAPSHOT_STALE_AFTER_MS;
}

function formatSnapshotTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toISOString().slice(0, 10);
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
