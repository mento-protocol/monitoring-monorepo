import { NextResponse } from "next/server";
import { PegMonitoringResponseSchema } from "@/lib/peg-monitoring-schema";

export const dynamic = "force-dynamic";
export const PEG_MONITORING_UPSTREAM_TIMEOUT_MS = 10_000;
export const PEG_MONITORING_MAX_RESPONSE_BYTES = 512 * 1024;
const headers = { "Cache-Control": "no-store" } as const;

class InvalidUpstreamResponseError extends Error {}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

export function resolvePegMonitoringEndpoint(
  raw: string | undefined,
): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    )
      return null;
    url.pathname = "/peg/decision-packages";
    return url;
  } catch {
    return null;
  }
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) ||
      Number(length) > PEG_MONITORING_MAX_RESPONSE_BYTES)
  )
    throw new InvalidUpstreamResponseError();
  if (response.body === null) throw new InvalidUpstreamResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered streams expose one bounded chunk at a time
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > PEG_MONITORING_MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new InvalidUpstreamResponseError();
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidUpstreamResponseError();
  }
}

function timedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function GET(): Promise<NextResponse> {
  const endpoint = resolvePegMonitoringEndpoint(process.env.METRICS_BRIDGE_URL);
  if (endpoint === null)
    return errorResponse("Peg monitoring upstream is not configured", 503);
  try {
    const upstream = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PEG_MONITORING_UPSTREAM_TIMEOUT_MS),
    });
    if (upstream.status === 503)
      return errorResponse("peg decision packages unavailable", 503);
    if (!upstream.ok)
      return errorResponse("Peg monitoring upstream unavailable", 502);
    if (!upstream.headers.get("content-type")?.includes("application/json"))
      throw new InvalidUpstreamResponseError();
    const parsed = PegMonitoringResponseSchema.safeParse(
      JSON.parse(await readBounded(upstream)) as unknown,
    );
    if (!parsed.success) throw new InvalidUpstreamResponseError();
    return NextResponse.json(parsed.data, { headers });
  } catch (error) {
    if (timedOut(error))
      return errorResponse("Peg monitoring upstream timed out", 504);
    return errorResponse("Peg monitoring upstream response is invalid", 502);
  }
}
