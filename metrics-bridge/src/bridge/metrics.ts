import { Gauge, type Registry } from "prom-client";
import { tokenSymbol } from "@mento-protocol/config/tokens";
import {
  BRIDGE_STUCK_THRESHOLD_SECONDS,
  bridgeStateAgeSeconds,
  deriveBridgeStatus,
  isBridgeInFlight,
  type BridgeProgression,
} from "@mento-protocol/config/bridge-status";
import {
  BRIDGE_CHAIN_LABELS,
  BRIDGE_FRESHNESS_SECONDS,
  BRIDGE_TOKEN_LABELS,
} from "./config.js";
import type { BridgeRow } from "./observation.js";

const statuses = [
  "PENDING",
  "SENT",
  "ATTESTED",
  "QUEUED_INBOUND",
  "unknown",
] as const;
const labelNames = [
  "source_chain",
  "destination_chain",
  "token",
  "status",
] as const;
type Labels = Record<(typeof labelNames)[number], string>;
interface Bucket {
  labels: Labels;
  count: number;
  stuck: number;
  oldest: number;
}

function chainLabel(chain: number | null): string {
  return (
    BRIDGE_CHAIN_LABELS.find((label) => label === String(chain)) ?? "unknown"
  );
}
function tokenLabel(row: BridgeRow): string {
  if (row.tokenAddress === null) return "unknown";
  const symbols = [row.sourceChainId, row.destChainId].flatMap((chain) => {
    if (chain === null || chainLabel(chain) === "unknown") return [];
    const symbol = tokenSymbol(chain, row.tokenAddress!);
    return symbol === "USDm" || symbol === "EURm" ? [symbol] : [];
  });
  return symbols.length > 0 && symbols.every((symbol) => symbol === symbols[0])
    ? symbols[0]!
    : "unknown";
}
function key(labels: Labels): string {
  return labelNames.map((name) => labels[name]).join(":");
}
function emptyBuckets(): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  const routes = BRIDGE_CHAIN_LABELS.flatMap((source_chain) =>
    BRIDGE_CHAIN_LABELS.map((destination_chain) => ({
      source_chain,
      destination_chain,
    })),
  );
  for (const route of routes) {
    if (
      ![route.source_chain, route.destination_chain].some(
        (chain) => chain === "137" || chain === "unknown",
      )
    )
      continue;
    for (const token of BRIDGE_TOKEN_LABELS)
      for (const status of statuses) {
        const labels = { ...route, token, status };
        buckets.set(key(labels), { labels, count: 0, stuck: 0, oldest: 0 });
      }
  }
  return buckets;
}

function addRow(bucket: Bucket, row: BridgeRow, nowSeconds: number): boolean {
  bucket.count++;
  const age = isBridgeInFlight(row.status)
    ? bridgeStateAgeSeconds(row as BridgeProgression, nowSeconds)
    : null;
  if (age !== null) {
    bucket.oldest = Math.max(bucket.oldest, age);
    if (deriveBridgeStatus(row as BridgeProgression, nowSeconds) === "STUCK")
      bucket.stuck++;
  }
  return (
    Object.values(bucket.labels).includes("unknown") || age === null || age < 0
  );
}

export function aggregateBridgeTransfers(
  rows: BridgeRow[],
  nowSeconds: number,
): { buckets: Bucket[]; invalidRows: number } {
  const buckets = emptyBuckets();
  let invalidRows = 0;
  for (const row of new Map(rows.map((row) => [row.id, row])).values()) {
    if (["DELIVERED", "CANCELLED", "FAILED"].includes(row.status)) continue;
    const labels = {
      source_chain: chainLabel(row.sourceChainId),
      destination_chain: chainLabel(row.destChainId),
      token: tokenLabel(row),
      status: isBridgeInFlight(row.status) ? row.status : "unknown",
    };
    const bucket = buckets.get(key(labels));
    if (bucket && addRow(bucket, row, nowSeconds)) invalidRows++;
  }
  return { buckets: [...buckets.values()], invalidRows };
}

function registerBridgeGauges(register: Registry) {
  const gauge = (
    definition: { name: string; help: string },
    labels: readonly string[] = [],
  ) =>
    new Gauge({
      ...definition,
      labelNames: [...labels],
      registers: [register],
    });
  const count = gauge(
    {
      name: "mento_ntt_bridge_transfers",
      help: "Last complete non-terminal bridge transfer count",
    },
    labelNames,
  );
  const stuck = gauge(
    {
      name: "mento_ntt_bridge_stuck_transfers",
      help: "Last complete count strictly beyond the status threshold",
    },
    labelNames,
  );
  const oldest = gauge(
    {
      name: "mento_ntt_bridge_oldest_state_age_seconds",
      help: "Oldest known state age at the last complete observation",
    },
    labelNames,
  );
  const invalid = gauge({
    name: "mento_ntt_bridge_invalid_rows",
    help: "Rows with unknown route, token, status or unusable time at last success",
  });
  const lastSuccess = gauge({
    name: "mento_ntt_bridge_last_success_timestamp_seconds",
    help: "Unix time of last complete observation; zero means never observed",
  });
  const error = gauge({
    name: "mento_ntt_bridge_observation_error",
    help: "One before first success or after an incomplete or failed observation",
  });
  const freshness = gauge({
    name: "mento_ntt_bridge_freshness_limit_seconds",
    help: "Maximum complete-observation age from cadence plus timeout",
  });
  return { count, stuck, oldest, invalid, lastSuccess, error, freshness };
}

/** Gauge updates are synchronous: a scrape cannot interleave a complete snapshot commit. */
export function createBridgeMetrics(register: Registry) {
  const { count, stuck, oldest, invalid, lastSuccess, error, freshness } =
    registerBridgeGauges(register);
  lastSuccess.set(0);
  error.set(1);
  freshness.set(BRIDGE_FRESHNESS_SECONDS);
  const thresholds = new Gauge({
    name: "mento_ntt_bridge_warning_threshold_seconds",
    help: "Configured status threshold used to count stuck transfers",
    labelNames: ["status"],
    registers: [register],
  });
  for (const [status, seconds] of Object.entries(
    BRIDGE_STUCK_THRESHOLD_SECONDS,
  ))
    thresholds.set({ status }, seconds);
  // No route samples before success: startup cannot masquerade as known empty.
  return {
    fail() {
      error.set(1);
    },
    publish(rows: BridgeRow[], nowSeconds: number) {
      const snapshot = aggregateBridgeTransfers(rows, nowSeconds);
      for (const bucket of snapshot.buckets) {
        count.set(bucket.labels, bucket.count);
        stuck.set(bucket.labels, bucket.stuck);
        oldest.set(bucket.labels, bucket.oldest);
      }
      invalid.set(snapshot.invalidRows);
      lastSuccess.set(nowSeconds);
      error.set(0);
    },
  };
}
export type BridgeMetrics = ReturnType<typeof createBridgeMetrics>;
