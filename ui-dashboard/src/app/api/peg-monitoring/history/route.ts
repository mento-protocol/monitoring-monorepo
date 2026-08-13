import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  PEG_HISTORY_RANGE_OPTIONS,
  PEG_HISTORY_RANGES,
  type PegHistoryPoint,
  type PegHistoryResponse,
} from "@/lib/peg-history";

export const dynamic = "force-dynamic";
export const PEG_HISTORY_UPSTREAM_TIMEOUT_MS = 8_000;
export const PEG_HISTORY_MAX_RESPONSE_BYTES = 512 * 1024;
export const PEG_HISTORY_DATASOURCE_UID = "grafanacloud-prom";

const responseHeaders = { "Cache-Control": "no-store" } as const;
const label = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const querySchema = z
  .object({
    asset: label,
    source: label,
    policyVersion: label,
    range: z.enum(PEG_HISTORY_RANGE_OPTIONS),
    /** Optional confirmed package timestamp, expressed as Unix seconds. */
    to: z
      .string()
      .regex(/^[1-9]\d{0,12}$/)
      .transform(Number)
      .refine(Number.isSafeInteger)
      .optional(),
  })
  .strict();
const grafanaFieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const grafanaFrameSchema = z
  .object({
    schema: z
      .object({ fields: z.array(grafanaFieldSchema).min(1).max(8) })
      .passthrough(),
    data: z
      .object({ values: z.array(z.array(z.unknown())).min(1).max(8) })
      .passthrough(),
  })
  .passthrough();
const grafanaResponseSchema = z
  .object({
    results: z.record(
      z.string(),
      z
        .object({
          frames: z.array(grafanaFrameSchema).max(4),
          error: z.string().optional(),
          status: z.number().int().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
type GrafanaFrame = z.infer<typeof grafanaFrameSchema>;

class InvalidUpstreamResponseError extends Error {}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: responseHeaders });
}

export function resolveGrafanaQueryEndpoint(
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
    url.pathname = "/api/ds/query";
    return url;
  } catch {
    return null;
  }
}

function signedDeviationPromql(input: {
  asset: string;
  source: string;
  policyVersion: string;
}): string {
  const selector = `asset=${JSON.stringify(input.asset)},source=${JSON.stringify(input.source)},policy_version=${JSON.stringify(input.policyVersion)}`;
  return `mento_peg_premium_bps{${selector}} - on(asset,source,policy_version) mento_peg_deviation_bps{${selector}}`;
}

function buildGrafanaRequest(
  input: z.infer<typeof querySchema>,
  fromMs: number,
  toMs: number,
): object {
  const settings = PEG_HISTORY_RANGES[input.range];
  return {
    queries: [
      {
        refId: "A",
        datasource: { type: "prometheus", uid: PEG_HISTORY_DATASOURCE_UID },
        expr: signedDeviationPromql(input),
        format: "time_series",
        range: true,
        instant: false,
        intervalMs: settings.stepSeconds * 1_000,
        maxDataPoints:
          Math.ceil(settings.windowSeconds / settings.stepSeconds) + 1,
      },
    ],
    from: String(fromMs),
    to: String(toMs),
  };
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > PEG_HISTORY_MAX_RESPONSE_BYTES)
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
    if (total > PEG_HISTORY_MAX_RESPONSE_BYTES) {
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

function onlyFieldIndex(frame: GrafanaFrame, type: string): number {
  const indexes = frame.schema.fields.flatMap((field, index) =>
    field.type === type ? [index] : [],
  );
  if (indexes.length !== 1) throw new InvalidUpstreamResponseError();
  return indexes[0]!;
}

function parsePoint(
  atMs: unknown,
  bps: unknown,
  fromMs: number,
  toMs: number,
): PegHistoryPoint | null {
  if (bps === null) return null;
  if (
    typeof atMs !== "number" ||
    !Number.isFinite(atMs) ||
    !Number.isInteger(atMs) ||
    atMs < fromMs ||
    atMs > toMs ||
    typeof bps !== "number" ||
    !Number.isFinite(bps)
  )
    throw new InvalidUpstreamResponseError();
  return { at: atMs / 1_000, bps };
}

function parseFramePoints(
  frame: GrafanaFrame,
  fromMs: number,
  toMs: number,
  expected: z.infer<typeof querySchema>,
): PegHistoryPoint[] {
  const points = new Map<number, number>();
  if (frame.schema.fields.length !== frame.data.values.length)
    throw new InvalidUpstreamResponseError();
  const times = frame.data.values[onlyFieldIndex(frame, "time")]!;
  const numberIndex = onlyFieldIndex(frame, "number");
  const labels = frame.schema.fields[numberIndex]?.labels;
  if (
    labels === undefined ||
    labels.asset !== expected.asset ||
    labels.source !== expected.source ||
    labels.policy_version !== expected.policyVersion
  )
    throw new InvalidUpstreamResponseError();
  const values = frame.data.values[numberIndex]!;
  if (times.length !== values.length) throw new InvalidUpstreamResponseError();
  for (let index = 0; index < times.length; index++) {
    const point = parsePoint(times[index], values[index], fromMs, toMs);
    if (point === null) continue;
    const existing = points.get(point.at);
    if (existing !== undefined && existing !== point.bps)
      throw new InvalidUpstreamResponseError();
    points.set(point.at, point.bps);
  }
  return [...points.entries()]
    .sort(([left], [right]) => left - right)
    .map(([at, bps]) => ({ at, bps }));
}

function parseGrafanaPoints(
  raw: unknown,
  fromMs: number,
  toMs: number,
  expected: z.infer<typeof querySchema>,
): PegHistoryPoint[] {
  const parsed = grafanaResponseSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidUpstreamResponseError();
  const result = parsed.data.results.A;
  if (result === undefined) throw new InvalidUpstreamResponseError();
  if (
    (result.error !== undefined && result.error.trim() !== "") ||
    (result.status !== undefined &&
      (result.status < 200 || result.status >= 300))
  )
    throw new InvalidUpstreamResponseError();
  const populated = result.frames.reduce<PegHistoryPoint[][]>((all, frame) => {
    const points = parseFramePoints(frame, fromMs, toMs, expected);
    if (points.length > 0) all.push(points);
    return all;
  }, []);
  if (populated.length > 1) throw new InvalidUpstreamResponseError();
  const points = populated[0] ?? [];
  const maximum =
    Math.ceil(
      PEG_HISTORY_RANGES[expected.range].windowSeconds /
        PEG_HISTORY_RANGES[expected.range].stepSeconds,
    ) + 1;
  if (points.length > maximum) throw new InvalidUpstreamResponseError();
  return points;
}

function timedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const input = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!input.success) return errorResponse("Invalid peg history query", 400);
  const requestNowMs = Date.now();
  const toMs =
    input.data.to === undefined ? requestNowMs : input.data.to * 1_000;
  if (toMs > requestNowMs)
    return errorResponse("Invalid peg history query", 400);
  const endpoint = resolveGrafanaQueryEndpoint(process.env.GRAFANA_QUERY_URL);
  const token = process.env.GRAFANA_QUERY_TOKEN?.trim();
  if (endpoint === null || !token)
    return errorResponse("Peg history is not configured", 503);
  const settings = PEG_HISTORY_RANGES[input.data.range];
  const fromMs = toMs - settings.windowSeconds * 1_000;
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGrafanaRequest(input.data, fromMs, toMs)),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PEG_HISTORY_UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok)
      return errorResponse("Peg history upstream unavailable", 502);
    if (!upstream.headers.get("content-type")?.includes("application/json"))
      throw new InvalidUpstreamResponseError();
    const points = parseGrafanaPoints(
      JSON.parse(await readBounded(upstream)) as unknown,
      fromMs,
      toMs,
      input.data,
    );
    const response: PegHistoryResponse = {
      ...input.data,
      from: fromMs / 1_000,
      to: toMs / 1_000,
      stepSeconds: settings.stepSeconds,
      points,
    };
    return NextResponse.json(response, { headers: responseHeaders });
  } catch (error) {
    if (timedOut(error)) return errorResponse("Peg history timed out", 504);
    return errorResponse("Peg history upstream response is invalid", 502);
  }
}
