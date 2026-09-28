import type { Hex } from "viem";
import { STORAGE_UPLOAD_BASE_URL } from "./quicknode-replay-protection";

const PREFIX = "pool-liquidity-withdrawals/137/";
const CURSOR_NAME = "pool-liquidity-retry-cursor/137.json";
const KEY_PATTERN =
  /^pool-liquidity-withdrawals\/137\/([a-z0-9-]{1,64})\/(0x[0-9a-f]{64})-(\d+)\.json$/;
const PAGE_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export type ScanKey = {
  txHash: Hex;
  logIndex: number;
  watch: { id: string };
};
type Fetch = typeof fetch;

function objectUrl(bucket: string): URL {
  return new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(CURSOR_NAME)}`,
  );
}

async function readCursor(fetchImpl: Fetch, token: string, bucket: string) {
  const url = objectUrl(bucket);
  const headers = { authorization: `Bearer ${token}` };
  const metadata = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (metadata.status === 404)
    return { after: null as string | null, generation: "0" };
  if (!metadata.ok)
    throw new Error(`Watched LP retry cursor read failed: ${metadata.status}`);
  const info = (await metadata.json()) as { generation?: unknown };
  if (typeof info.generation !== "string")
    throw new Error("Watched LP retry cursor has no generation");
  url.searchParams.set("alt", "media");
  url.searchParams.set("ifGenerationMatch", info.generation);
  const content = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!content.ok)
    throw new Error(
      `Watched LP retry cursor content failed: ${content.status}`,
    );
  const value = (await content.json()) as { after?: unknown };
  if (
    value.after !== null &&
    (typeof value.after !== "string" || !KEY_PATTERN.test(value.after))
  )
    throw new Error("Watched LP retry cursor is invalid");
  return { after: value.after as string | null, generation: info.generation };
}

async function writeCursor(
  fetchImpl: Fetch,
  token: string,
  bucket: string,
  after: string | null,
  generation: string,
): Promise<string> {
  const url = new URL(
    `${STORAGE_UPLOAD_BASE_URL}/${encodeURIComponent(bucket)}/o`,
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", CURSOR_NAME);
  url.searchParams.set("ifGenerationMatch", generation);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ after }),
  });
  if (!response.ok)
    throw new Error(`Watched LP retry cursor write failed: ${response.status}`);
  const object = (await response.json()) as { generation?: unknown };
  if (typeof object.generation !== "string")
    throw new Error("Watched LP retry cursor write has no generation");
  return object.generation;
}

/** Scan bounded GCS pages, saving progress before each Scheduler run ends. */
export async function scanPoolDeliveryKeys(options: {
  fetchImpl: Fetch;
  token: string;
  bucket: string;
  now: () => number;
  deadline: number;
  onKey: (key: ScanKey) => Promise<boolean>;
}): Promise<{ deferred: boolean; incomplete: boolean }> {
  const { fetchImpl, token, bucket, now, deadline, onKey } = options;
  const cursor = await readCursor(fetchImpl, token, bucket);
  let after = cursor.after;
  let generation = cursor.generation;
  let pageToken: string | undefined;
  let pages = 0;
  const save = async (next: string | null) => {
    if (next !== after) {
      generation = await writeCursor(
        fetchImpl,
        token,
        bucket,
        next,
        generation,
      );
      after = next;
    }
  };

  while (pages++ < PAGE_LIMIT && now() < deadline) {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
    );
    url.searchParams.set("prefix", PREFIX);
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "items(name),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    else if (after) url.searchParams.set("startOffset", after);
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`Watched LP retry list failed: ${response.status}`);
    const page = (await response.json()) as {
      items?: Array<{ name?: string }>;
      nextPageToken?: string;
    };
    let last = after;
    for (const item of page.items ?? []) {
      const name = item.name ?? "";
      if (name === after) continue; // startOffset is inclusive.
      const match = KEY_PATTERN.exec(name);
      if (!match) throw new Error("Unexpected Watched LP delivery object name");
      const processed = await onKey({
        watch: { id: match[1] },
        txHash: match[2] as Hex,
        logIndex: Number(match[3]),
      });
      if (!processed) {
        await save(last);
        return { deferred: true, incomplete: false };
      }
      last = name;
      if (now() >= deadline) break;
    }
    await save(last);
    if (now() >= deadline) return { deferred: false, incomplete: true };
    if (!page.nextPageToken) {
      await save(null); // Wrap so new keys before the cursor are seen next run.
      return { deferred: false, incomplete: false };
    }
    pageToken = page.nextPageToken;
  }
  return { deferred: false, incomplete: true };
}
