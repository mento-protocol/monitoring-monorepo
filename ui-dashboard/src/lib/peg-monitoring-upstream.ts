// Server-only by convention (like lib/volume-ssr.ts): reads
// `METRICS_BRIDGE_URL`, which is never exposed to the browser, and is imported
// only from the API route and the OG-card builder. Deliberately NOT using
// `import "server-only"` — that guard throws under the (non-RSC) vitest
// environment the route tests run in.
import { type ApiFailureClass } from "@/lib/api-failure";
import {
  PegMonitoringResponseSchema,
  type PegMonitoringResponse,
} from "@/lib/peg-monitoring-schema";

export const PEG_MONITORING_UPSTREAM_TIMEOUT_MS = 10_000;
export const PEG_MONITORING_MAX_RESPONSE_BYTES = 512 * 1024;

class InvalidUpstreamResponseError extends Error {}

export type PegUpstreamResult =
  | { ok: true; data: PegMonitoringResponse }
  | {
      ok: false;
      message: string;
      status: number;
      failureClass: ApiFailureClass;
      upstreamStatus?: number;
    };

function failure(
  message: string,
  status: number,
  failureClass: ApiFailureClass,
  upstreamStatus?: number,
): PegUpstreamResult {
  return {
    ok: false,
    message,
    status,
    failureClass,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  };
}

/**
 * The bridge origin arrives as operator-supplied configuration, so it is
 * treated as untrusted: only a bare HTTPS origin passes, and the path is
 * always rewritten to the one endpoint we call. Credentials, queries,
 * fragments and paths are rejected outright rather than stripped, so a
 * misconfigured value fails loudly instead of silently pointing somewhere
 * else. Plain HTTP is allowed for loopback in development only.
 */
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

/**
 * Drop an unread body so its connection is released now rather than at the
 * next GC. Every rejection path below runs this before throwing: under a
 * misbehaving upstream returning a stream of invalid responses, leaving them
 * undrained holds sockets open for as long as the process lives.
 */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) ||
      Number(length) > PEG_MONITORING_MAX_RESPONSE_BYTES)
  ) {
    discardBody(response);
    throw new InvalidUpstreamResponseError();
  }
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

function classifyUpstreamStatus(upstream: Response): PegUpstreamResult | null {
  if (upstream.status === 429)
    return failure(
      "Peg monitoring upstream rate limited",
      502,
      "upstream-rate-limit",
      upstream.status,
    );
  if (upstream.status === 503)
    return failure(
      "peg decision packages unavailable",
      503,
      "upstream-unavailable",
      upstream.status,
    );
  if (!upstream.ok)
    return failure(
      "Peg monitoring upstream unavailable",
      502,
      "upstream-http",
      upstream.status,
    );
  return null;
}

/**
 * Single server-side reader for the Metrics Bridge decision packages. Both
 * the `/api/peg-monitoring` proxy and the route's social card go through
 * here, so the origin allowlist, the response-size ceiling and the schema
 * check can never drift apart between the two callers.
 */
export async function fetchPegDecisionPackages(): Promise<PegUpstreamResult> {
  const endpoint = resolvePegMonitoringEndpoint(process.env.METRICS_BRIDGE_URL);
  if (endpoint === null)
    return failure(
      "Peg monitoring upstream is not configured",
      503,
      "configuration",
    );
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PEG_MONITORING_UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (timedOut(error))
      return failure("Peg monitoring upstream timed out", 504, "timeout");
    return failure("Peg monitoring upstream request failed", 502, "network");
  }
  const statusFailure = classifyUpstreamStatus(upstream);
  if (statusFailure !== null) {
    // A rate-limited or erroring upstream still sends a body we never read.
    discardBody(upstream);
    return statusFailure;
  }
  try {
    if (!upstream.headers.get("content-type")?.includes("application/json")) {
      discardBody(upstream);
      throw new InvalidUpstreamResponseError();
    }
    const parsed = PegMonitoringResponseSchema.safeParse(
      JSON.parse(await readBounded(upstream)) as unknown,
    );
    if (!parsed.success) throw new InvalidUpstreamResponseError();
    return { ok: true, data: parsed.data };
  } catch (error) {
    if (timedOut(error))
      return failure("Peg monitoring upstream timed out", 504, "timeout");
    if (error instanceof TypeError)
      return failure("Peg monitoring upstream request failed", 502, "network");
    return failure(
      "Peg monitoring upstream response is invalid",
      502,
      "invalid-payload",
    );
  }
}
