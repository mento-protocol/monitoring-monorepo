import { formatUnits, type Hex } from "viem";
import { POLL_INTERVAL_MS } from "./config.js";
import {
  CAPA_LP_OWNER,
  isOwnerWithdrawal,
  type IndexedBurn,
} from "./capa-withdrawal.js";
import { fetchRecentPoolBurns } from "./graphql.js";
import { counters, gauges } from "./metrics.js";
import { getRpcClient } from "./rpc.js";

// One narrow, six-hour window bounds event labels and keeps a Grafana alert
// active long enough for normal indexing/scrape lag. The GraphQL query caps
// the window at ten burns and fails loudly if that assumption is exceeded.
export const WITHDRAWAL_WINDOW_SECONDS = 6 * 60 * 60;

function amountLabel(wei: string): string {
  const [whole, fraction = ""] = formatUnits(BigInt(wei), 18).split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export async function refreshCapaWithdrawals(
  owner: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const client = getRpcClient(137);
  if (!client)
    throw new Error("Polygon RPC unavailable for Capa withdrawal proof");
  const rows = await fetchRecentPoolBurns(
    nowSeconds - WITHDRAWAL_WINDOW_SECONDS,
  );
  const matches = await Promise.all(
    rows.map(async (row: IndexedBurn) => {
      const timestamp = Number(row.blockTimestamp);
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp > nowSeconds + 120 ||
        timestamp < nowSeconds - WITHDRAWAL_WINDOW_SECONDS
      )
        return null;
      const receipt = await client.getTransactionReceipt({
        hash: row.txHash as Hex,
      });
      return isOwnerWithdrawal(row, receipt, owner) ? row : null;
    }),
  );

  const samples = matches
    .filter((row) => row !== null)
    .map((row) => ({
      labels: {
        event_id: row.id,
        tx_hash: row.txHash.toLowerCase(),
        owner: owner.toLowerCase(),
        eurm: amountLabel(row.amount0),
        usdm: amountLabel(row.amount1),
      },
      timestamp: Number(row.blockTimestamp),
    }));
  // Commit a complete cycle atomically: a failed Hasura/RPC/format read
  // retains the prior bounded window, not a partial set.
  gauges.capaWithdrawal.reset();
  for (const sample of samples) {
    gauges.capaWithdrawal.set(sample.labels, sample.timestamp);
  }
}

async function loop(): Promise<void> {
  try {
    await refreshCapaWithdrawals(CAPA_LP_OWNER);
  } catch (error) {
    counters.pollErrors.inc({ kind: "capa_withdrawal" });
    console.error("Capa withdrawal poll failed:", error);
  }
  setTimeout(() => void loop(), POLL_INTERVAL_MS);
}

export function startCapaWithdrawalPolling(): void {
  void loop();
}
