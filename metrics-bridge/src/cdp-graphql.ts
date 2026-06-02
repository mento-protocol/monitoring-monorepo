import { GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type {
  BridgeCdpsResponse,
  CdpInstance,
  LiquityInstanceRow,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

// CDP markets (Liquity v2 forks: GBPm / CHFm / JPYm) live in their own
// indexer entities, isolated from the FPMM `Pool` table, so this query is
// fetched separately and its failures stay in the bridge's `cdp_query`
// channel without touching the FPMM poll. Only schema-stable columns are
// selected — every field below has shipped in production.
//
// Unlike the FPMM *companion* queries (which swallow unknown-field errors to
// drop one optional annotation), this is the PRIMARY CDP fetch: a schema-drift
// failure must surface as a `cdp_query` poll error, NOT a silent empty result.
// Returning [] here would clear every `mento_cdp_*` series and — because all
// CDP rules are `no_data_state = "OK"` — disable the whole alert surface with
// no operator signal. So the request error is left to propagate to
// `refreshCdpMetrics`, which records it and leaves the last-good gauges in
// place (it never calls `updateCdpMetrics([])`). Matches the FPMM *base*-query
// posture, which likewise does not special-case unknown-field.
const BRIDGE_CDPS_QUERY = gql`
  query BridgeCdps {
    LiquityInstance {
      id
      collateralId
      chainId
      systemDebt
      spDeposits
      spHeadroom
      isShutDown
      liqCountCum
      redemptionCountCum
      rebalanceRedemptionCountCum
      shortfallSubsidyCum
    }
    LiquityCollateral {
      id
      symbol
      chainId
      troveManager
      debtToken
      systemParamsLoaded
    }
  }
`;

const client = new GraphQLClient(HASURA_URL);

// Returns one joined row per CDP instance that has a matching collateral. An
// instance without its collateral row (mid-bootstrap) is skipped rather than
// guessed — its labels and `systemParamsLoaded` gate live on the collateral.
// Request errors (including schema drift) propagate to `refreshCdpMetrics`.
export async function fetchCdps(): Promise<CdpInstance[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const data = await client.request<BridgeCdpsResponse>({
    document: BRIDGE_CDPS_QUERY,
    signal,
  });

  const collateralById = new Map(data.LiquityCollateral.map((c) => [c.id, c]));
  const joined: CdpInstance[] = [];
  for (const instance of data.LiquityInstance as LiquityInstanceRow[]) {
    const collateral = collateralById.get(instance.collateralId);
    if (collateral === undefined) continue;
    joined.push({ instance, collateral });
  }
  return joined;
}
