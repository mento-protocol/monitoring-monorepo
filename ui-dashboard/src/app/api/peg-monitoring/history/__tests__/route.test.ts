import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST,
  PEG_HISTORY_DATASOURCE_UID,
  PEG_HISTORY_MAX_RESPONSE_BYTES,
  PEG_HISTORY_UPSTREAM_TIMEOUT_MS,
  resolveGrafanaQueryEndpoint,
} from "../route";

const NOW_MS = Date.UTC(2026, 7, 13, 20, 17);
const baseQuery = {
  asset: "europ-schuman",
  source: "bitvavo_eur",
  policyVersion: "europ-v1",
  range: "7d",
};
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const request = (query: Record<string, string> = baseQuery) =>
  new NextRequest(
    `http://localhost/api/peg-monitoring/history?${new URLSearchParams(query)}`,
  );
const seriesLabels = {
  asset: baseQuery.asset,
  source: baseQuery.source,
  policy_version: baseQuery.policyVersion,
};
const alignToStep = (valueMs: number, stepMs: number) =>
  Math.floor(valueMs / stepMs) * stepMs;
const BASE_TO_MS = alignToStep(NOW_MS, 1_800_000);
const frame = (
  times: unknown[],
  values: unknown[],
  labels: Record<string, string> = seriesLabels,
) => ({
  schema: {
    refId: "A",
    fields: [
      { name: "Time", type: "time" },
      { name: "Value", type: "number", labels },
    ],
  },
  data: { values: [times, values] },
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("GRAFANA_QUERY_URL", "https://grafana.example");
  vi.stubEnv("GRAFANA_QUERY_TOKEN", "test-viewer-token");
});

describe("POST /api/peg-monitoring/history", () => {
  it("queries the exact policy and deep source with the bounded 7d contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        results: {
          A: {
            frames: [
              frame(
                [BASE_TO_MS - 3_600_000, BASE_TO_MS - 1_800_000, BASE_TO_MS],
                [-4.5, null, 2.25],
              ),
            ],
          },
        },
      }),
    );

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ...baseQuery,
      from: (BASE_TO_MS - 7 * 86_400_000) / 1_000,
      to: BASE_TO_MS / 1_000,
      stepSeconds: 1_800,
      points: [
        { at: (BASE_TO_MS - 3_600_000) / 1_000, bps: -4.5 },
        { at: BASE_TO_MS / 1_000, bps: 2.25 },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://grafana.example/api/ds/query");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-viewer-token",
    );
    const body = JSON.parse(String(init?.body)) as {
      from: string;
      to: string;
      queries: Array<Record<string, unknown>>;
    };
    expect(body.from).toBe(String(BASE_TO_MS - 7 * 86_400_000));
    expect(body.to).toBe(String(BASE_TO_MS));
    expect(body.queries).toEqual([
      expect.objectContaining({
        datasource: {
          type: "prometheus",
          uid: PEG_HISTORY_DATASOURCE_UID,
        },
        expr: 'mento_peg_premium_bps{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} - on(asset,source,policy_version) mento_peg_deviation_bps{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"}',
        intervalMs: 1_800_000,
        maxDataPoints: 337,
        range: true,
        instant: false,
      }),
    ]);
    expect(PEG_HISTORY_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("maps every range to its reviewed window and step", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ results: { A: { frames: [] } } }));
    const cases = [
      ["24h", 86_400_000, 300_000, 289],
      ["7d", 7 * 86_400_000, 1_800_000, 337],
      ["30d", 30 * 86_400_000, 7_200_000, 361],
    ] as const;
    const responses = await Promise.all(
      cases.map(([range]) => POST(request({ ...baseQuery, range }))),
    );
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      const call = fetchMock.mock.calls[index]!;
      const body = JSON.parse(String(call[1]?.body)) as {
        from: string;
        to: string;
        queries: Array<{ intervalMs: number; maxDataPoints: number }>;
      };
      const [, windowMs, intervalMs, maxDataPoints] = cases[index]!;
      const alignedToMs = alignToStep(NOW_MS, intervalMs);
      expect(body.from).toBe(String(alignedToMs - windowMs));
      expect(body.to).toBe(String(alignedToMs));
      expect(body.queries[0]).toMatchObject({ intervalMs, maxDataPoints });
    });
  });

  it("pins a retained package query to its confirmed timestamp", async () => {
    const confirmedAt = (NOW_MS - 60_000) / 1_000;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ results: { A: { frames: [] } } }));

    const response = await POST(
      request({ ...baseQuery, to: String(confirmedAt) }),
    );
    expect(response.status).toBe(200);
    const alignedConfirmedAtMs = alignToStep(confirmedAt * 1_000, 1_800_000);
    expect(await response.json()).toMatchObject({
      from: alignedConfirmedAtMs / 1_000 - 7 * 86_400,
      to: alignedConfirmedAtMs / 1_000,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      from: string;
      to: string;
    };
    expect(body.from).toBe(String(alignedConfirmedAtMs - 7 * 86_400_000));
    expect(body.to).toBe(String(alignedConfirmedAtMs));
  });

  it("rejects unbounded labels, unknown ranges, invalid end times, and extra parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(
      (await POST(request({ ...baseQuery, asset: 'europ"} or vector(1)' })))
        .status,
    ).toBe(400);
    expect((await POST(request({ ...baseQuery, range: "365d" }))).status).toBe(
      400,
    );
    expect(
      (await POST(request({ ...baseQuery, to: String(NOW_MS / 1_000 + 1) })))
        .status,
    ).toBe(400);
    expect((await POST(request({ ...baseQuery, to: "1.5" }))).status).toBe(400);
    expect(
      (await POST(request({ ...baseQuery, unexpected: "value" }))).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing credentials and unsafe Grafana origins", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const credentialedOrigin = [
      "https://",
      "user",
      ":",
      "pass",
      "@grafana.example",
    ].join("");
    for (const origin of [
      "",
      "http://grafana.example",
      credentialedOrigin,
      "https://grafana.example/subpath",
      "https://grafana.example?token=no",
    ]) {
      expect(resolveGrafanaQueryEndpoint(origin)).toBeNull();
    }
    vi.stubEnv("GRAFANA_QUERY_URL", "https://grafana.example");
    vi.stubEnv("GRAFANA_QUERY_TOKEN", "   ");
    expect((await POST(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for upstream errors, timeouts, oversized bodies, and malformed frames", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "secret" }, { status: 403 }))
      .mockRejectedValueOnce(new DOMException("secret", "TimeoutError"))
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(PEG_HISTORY_MAX_RESPONSE_BYTES + 1),
          },
        }),
      )
      .mockResolvedValueOnce(json({ results: { A: { frames: [{}] } } }))
      .mockResolvedValueOnce(
        json({
          results: {
            A: {
              frames: [
                frame([BASE_TO_MS], [-1]),
                frame([BASE_TO_MS - 1_800_000], [-2]),
              ],
            },
          },
        }),
      );
    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(504);
    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(502);
    expect(
      JSON.stringify(await (await postWithEmptyFetch(fetchMock)).json()),
    ).not.toContain("test-viewer-token");
  });

  it("rejects logical query errors and series from another identity", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        json({
          results: {
            A: { error: "query failed", status: 500, frames: [] },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          results: {
            A: {
              frames: [
                frame([BASE_TO_MS], [-1], {
                  ...seriesLabels,
                  source: "kraken_eur",
                }),
              ],
            },
          },
        }),
      );

    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(502);
  });

  it("preserves an extreme finite premium instead of hiding incident data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        results: {
          A: { frames: [frame([BASE_TO_MS], [25_000])] },
        },
      }),
    );

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).points).toEqual([
      { at: BASE_TO_MS / 1_000, bps: 25_000 },
    ]);
  });
});

async function postWithEmptyFetch(
  fetchMock: ReturnType<typeof vi.spyOn>,
): Promise<Response> {
  fetchMock.mockResolvedValueOnce(json({ results: { A: { frames: [] } } }));
  return POST(request());
}
