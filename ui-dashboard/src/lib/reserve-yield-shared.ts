import type { FetchImpl } from "@/lib/reserve-yield-types";

const FETCH_TIMEOUT_MS = 8_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

export function nullableStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function numericField(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function bigintField(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${label} was not an integer string`);
}

export function unixSecondsToIso(value: bigint): string | null {
  if (value <= BigInt(0)) return null;
  return new Date(Number(value) * 1000).toISOString();
}

export async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchJsonRpcEthCall(
  fetchImpl: FetchImpl,
  {
    rpcUrl,
    to,
    data,
  }: {
    rpcUrl: string;
    to: string;
    data: string;
  },
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGraphql(
  fetchImpl: FetchImpl,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const hasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL?.trim();
  if (!hasuraUrl) {
    throw new Error("NEXT_PUBLIC_HASURA_URL is not configured");
  }
  const res = await fetchImpl(hasuraUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchText(
  fetchImpl: FetchImpl,
  url: string,
): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export function errorMessage(label: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${label}: ${detail}`;
}

export function joinErrors(...errors: Array<string | null>): string | null {
  const present = errors.filter((error): error is string => error !== null);
  return present.length === 0 ? null : present.join("; ");
}
