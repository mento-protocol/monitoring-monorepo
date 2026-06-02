import { isoDay } from "./amounts.js";
import {
  HISTORY_KEY_PREFIX,
  LATEST_SNAPSHOT_KEY,
  type FetchLike,
  type IntegrationProbeSnapshot,
} from "./types.js";

const HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_UPSTASH_TIMEOUT_MS = 60_000;

export type WriteSnapshotResult = {
  latestKey: string;
  historyKey: string;
};

export async function writeSnapshotToUpstash(args: {
  snapshot: IntegrationProbeSnapshot;
  fetcher?: FetchLike | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
}): Promise<WriteSnapshotResult> {
  const env = args.env ?? process.env;
  const fetcher = args.fetcher ?? fetch;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const timeoutMs = args.timeoutMs ?? DEFAULT_UPSTASH_TIMEOUT_MS;
  if (args.snapshot.pairSource.kind !== "hasura") {
    throw new Error(
      "Refusing to publish integration probe snapshot without Hasura-derived active pairs.",
    );
  }
  if (!url || !token) {
    throw new Error(
      "Upstash Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  const historyKey = `${HISTORY_KEY_PREFIX}${isoDay(args.snapshot.generatedAt)}`;
  const payload = JSON.stringify(args.snapshot);
  const response = await fetcher(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(timeoutMs > 0 && { signal: AbortSignal.timeout(timeoutMs) }),
    body: JSON.stringify([
      ["SET", LATEST_SNAPSHOT_KEY, payload],
      ["SET", historyKey, payload, "EX", String(HISTORY_TTL_SECONDS)],
    ]),
  });
  if (!response.ok) {
    throw new Error(`Upstash write failed: HTTP ${response.status}`);
  }
  return { latestKey: LATEST_SNAPSHOT_KEY, historyKey };
}
