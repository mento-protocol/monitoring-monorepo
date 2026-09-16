import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
import {
  BROKER_LIMIT_POOL,
  BrokerLimitPoolSchema,
} from "@/lib/queries/limit-lookup";
import { buildPoolDetailUrl } from "@/lib/routing";

// Resolver route for Broker trading-limit alerts. A firing L0/L1/LG alert links
// here with the bytes32 `limitIdValue` label; the route trades it for the
// wrapping VirtualPool and sends the responder to that pool's Limits tab.
// A limit no VirtualPool indexes has no pool page, so it gets a short
// explanation instead of a 404 (issue #2447). That covers an unwrapped v2
// exchange and, per ADR 0103, a wrapped exchange whose row has not bootstrapped
// on its first indexed swap, so the copy claims neither.

// The lookup is an uncached POST, so the route always renders dynamically. That
// is deliberate: a cached miss would pin a stale "no pool page" answer while a
// responder is paging.

export const metadata: Metadata = {
  title: "Trading limit — Mento Analytics",
  description: "Open the pool page for a Broker trading-limit id.",
  robots: { index: false, follow: false },
};

const LIMIT_ID_PATTERN = /^0x[0-9a-f]{64}$/;

function decodeLimitId(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

// Every configured network that indexes VirtualPools: Celo mainnet today, plus
// Celo Sepolia when testnet networks are shown. Derived from `hasVirtualPools`
// rather than a hard-coded chain id so a second virtual-pool chain resolves
// without touching this route. The first network holding the row wins, and
// `poolId` is chain-namespaced, so the redirect lands on that same network.
// Local networks carry a relative `/api/hasura/...` proxy path that Node's
// `fetch` rejects on the server, so they are skipped rather than queried and
// counted as a failure. Networks can share one Hasura endpoint, so each query
// carries its own chain id.
const VIRTUAL_POOL_NETWORK_IDS = NETWORK_IDS.filter(
  (id) =>
    NETWORKS[id].hasVirtualPools &&
    isConfiguredNetworkId(id) &&
    /^https?:\/\//.test(NETWORKS[id].hasuraUrl),
);

type LimitLookup =
  | { kind: "pool"; poolId: string }
  | { kind: "none" }
  | { kind: "unavailable" };

const UNAVAILABLE = Symbol("unavailable");

async function findPoolId(limitId: string): Promise<LimitLookup> {
  // One shared deadline for the whole render, not one per network: a slow
  // endpoint aborts every in-flight request so the page still answers inside
  // the same budget.
  const signal = AbortSignal.timeout(HASURA_TIMEOUT_MS);
  const results = await Promise.all(
    VIRTUAL_POOL_NETWORK_IDS.map(async (networkId) => {
      try {
        const raw = await makeOgGraphQLClient(
          NETWORKS[networkId],
        ).request<unknown>({
          document: BROKER_LIMIT_POOL,
          variables: { limitId, chainId: NETWORKS[networkId].chainId },
          signal,
        });
        const parsed = BrokerLimitPoolSchema.safeParse(raw);
        if (!parsed.success) return UNAVAILABLE;
        return parsed.data.BrokerTradingLimit[0]?.poolId ?? null;
      } catch {
        // Fail closed to an explanatory page: a wedged endpoint must not turn
        // a paging responder's link into an error boundary.
        return UNAVAILABLE;
      }
    }),
  );
  const poolId = results.find((result) => typeof result === "string");
  if (poolId !== undefined) return { kind: "pool", poolId };
  // Unless every network answered, an empty result proves nothing. Say the
  // lookup failed rather than claim that no VirtualPool wraps the limit.
  if (results.length === 0 || results.includes(UNAVAILABLE))
    return { kind: "unavailable" };
  return { kind: "none" };
}

export default async function LimitResolverPage({
  params,
}: {
  params: Promise<{ limitId: string }>;
}) {
  const { limitId: raw } = await params;
  const limitId = decodeLimitId(raw);
  if (!LIMIT_ID_PATTERN.test(limitId)) notFound();

  const lookup = await findPoolId(limitId);
  if (lookup.kind === "pool") {
    redirect(
      buildPoolDetailUrl(lookup.poolId, new URLSearchParams({ tab: "limits" })),
    );
  }

  const unavailable = lookup.kind === "unavailable";

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8">
        <h1 className="mb-2 text-xl font-bold text-white">
          {unavailable
            ? "Could not look up this trading limit"
            : "No pool page for this trading limit"}
        </h1>
        <p className="mb-4 text-sm text-slate-400">
          {unavailable
            ? "The indexer did not answer, so this limit's pool page is unknown. Retry in a moment, or read its netflow and limits in Grafana."
            : "No VirtualPool indexes this limit. It usually belongs to a v2 exchange that no VirtualPool wraps, but a wrapped exchange lands here too until its first indexed swap records the limit. Read its netflow and limits in Grafana."}
        </p>
        <p className="mb-6 break-all font-mono text-xs text-slate-300">
          {limitId}
        </p>
        <Link
          href="/pools"
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
        >
          Browse pools
        </Link>
      </div>
    </div>
  );
}
