import { GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import { isUnknownFieldError } from "./graphql.js";
import type {
  BridgeCdpsResponse,
  CdpInstance,
  LiquityInstanceRow,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

// CDP markets (Liquity v2 forks: GBPm / CHFm / JPYm) live in their own
// indexer entities, isolated from the FPMM `Pool` table. The query is
// fetched on its own so a CDP-side schema mismatch during a deploy window
// (bridge ships ahead of an indexer re-sync) degrades to "no CDP gauges"
// instead of taking down the FPMM poll. Only schema-stable columns are
// selected — every field below has shipped in production.
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

let unknownFieldWarned = false;

// Returns one joined row per CDP instance that has a matching collateral. An
// instance without its collateral row (mid-bootstrap) is skipped rather than
// guessed — its labels and `systemParamsLoaded` gate live on the collateral.
export async function fetchCdps(): Promise<CdpInstance[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let data: BridgeCdpsResponse;
  try {
    data = await client.request<BridgeCdpsResponse>({
      document: BRIDGE_CDPS_QUERY,
      signal,
    });
  } catch (err) {
    if (!isUnknownFieldError(err)) throw err;
    if (!unknownFieldWarned) {
      unknownFieldWarned = true;
      console.warn(
        "[metrics-bridge] Hasura schema missing CDP (Liquity) entities; service=cdps gauges disabled until the indexer catches up.",
      );
    }
    return [];
  }

  const collateralById = new Map(data.LiquityCollateral.map((c) => [c.id, c]));
  const joined: CdpInstance[] = [];
  for (const instance of data.LiquityInstance as LiquityInstanceRow[]) {
    const collateral = collateralById.get(instance.collateralId);
    if (collateral === undefined) continue;
    joined.push({ instance, collateral });
  }
  return joined;
}
