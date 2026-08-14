import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEG_ALERTS_WINDOW_SECONDS } from "@/lib/peg-alerts";
import {
  GET,
  PEG_ALERTS_DATASOURCE_UID,
  PEG_ALERTS_MAX_EVENTS,
  PEG_ALERTS_MAX_POLICY_RESPONSE_BYTES,
  PEG_ALERTS_MAX_STATE_RESPONSE_BYTES,
  PEG_ALERTS_UPSTREAM_TIMEOUT_MS,
} from "../route";
import {
  PEG_ALERTS_MAX_STATE_ROWS,
  PEG_ALERTS_POLICY_STEP_SECONDS,
  policyQueryBounds,
} from "../peg-alert-events";

const NOW_SECONDS = 1_786_694_595;
const FROM_SECONDS = NOW_SECONDS - PEG_ALERTS_WINDOW_SECONDS;
const POLICY_BOUNDS = policyQueryBounds(FROM_SECONDS, NOW_SECONDS);

type StateLine = {
  schemaVersion: 1;
  previous: string;
  current: string;
  fingerprint: string;
  ruleTitle: string;
  ruleUID: string;
  labels: {
    alertname: string;
    asset: string;
    policy_version: string;
    route: "market" | "ops" | "page";
    service: "peg-monitoring";
    severity: "warning" | "critical";
    source: string;
  };
};

function stateLine(
  overrides: Omit<Partial<StateLine>, "labels"> & {
    labels?: Partial<StateLine["labels"]>;
  } = {},
): StateLine {
  const ruleTitle =
    overrides.ruleTitle ??
    "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · active]";
  return {
    schemaVersion: 1,
    previous: "Pending",
    current: "Alerting",
    fingerprint: "spread-instance",
    ruleTitle,
    ruleUID: "spread-rule",
    ...overrides,
    labels: {
      alertname: ruleTitle,
      asset: "europ-schuman",
      policy_version: "europ-v1",
      route: "market",
      service: "peg-monitoring",
      severity: "warning",
      source: "bitvavo_eur",
      ...overrides.labels,
    },
  };
}

function stateFrame(rows: Array<{ at: number; line: StateLine }>): object {
  return {
    schema: {
      name: "states",
      fields: [
        { name: "time", type: "time", typeInfo: { frame: "time.Time" } },
        { name: "line", type: "other", typeInfo: { frame: "json.RawMessage" } },
        {
          name: "labels",
          type: "other",
          typeInfo: { frame: "json.RawMessage" },
        },
      ],
    },
    data: {
      values: [
        rows.map(({ at }) => at * 1_000),
        rows.map(({ line }) => line),
        rows.map(() => ({
          from: "state-history",
          labels_service: "peg-monitoring",
        })),
      ],
    },
  };
}

function policyFrame(
  policyVersion: string,
  points: Array<{ at: number; value: number | null }>,
  instance = "bridge-a",
): object {
  return {
    schema: {
      fields: [
        { name: "Time", type: "time" },
        {
          name: "Value",
          type: "number",
          labels: {
            __name__: "mento_peg_policy_version",
            instance,
            policy_version: policyVersion,
          },
        },
      ],
    },
    data: {
      values: [
        points.map(({ at }) => at * 1_000),
        points.map(({ value }) => value),
      ],
    },
  };
}

function policyResponse(frames: object[] = []): object {
  return { results: { P: { frames } } };
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function successfulFetch() {
  const raisedRows = [
    // Ordinary evaluation churn is valid upstream data but never a feed event.
    {
      at: NOW_SECONDS - 1_500,
      line: stateLine({ previous: "Pending", current: "Normal" }),
    },
    {
      at: NOW_SECONDS - 1_200,
      line: stateLine(),
    },
    // Grafana can repeat an Alerting row while the same instance remains open.
    {
      at: NOW_SECONDS - 1_140,
      line: stateLine(),
    },
    {
      at: NOW_SECONDS - 300,
      line: stateLine({
        fingerprint: "critical-instance",
        ruleTitle: "Peg Deep-Venue Downside Critical [europ-schuman · active]",
        ruleUID: "critical-rule",
        labels: {
          alertname:
            "Peg Deep-Venue Downside Critical [europ-schuman · active]",
          route: "page",
          severity: "critical",
          source: "bitvavo_eur",
        },
      }),
    },
  ];
  const clearedRows = [
    {
      at: NOW_SECONDS - 600,
      line: stateLine({ previous: "Alerting", current: "Normal" }),
    },
    // Repeated clears after the incident closes must not create per-check rows.
    {
      at: NOW_SECONDS - 540,
      line: stateLine({ previous: "Alerting", current: "Normal" }),
    },
    // A clear without a raise in the bounded window has no honest duration.
    {
      at: NOW_SECONDS - 120,
      line: stateLine({
        previous: "Alerting",
        current: "Normal",
        fingerprint: "unpaired-instance",
      }),
    },
  ];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ds/query") {
      return json(
        policyResponse([
          // The old policy has a sample in the extra pre-window step.
          policyFrame("europ-old", [
            {
              at: POLICY_BOUNDS.fromMs / 1_000,
              value: 1,
            },
            { at: FROM_SECONDS, value: 1 },
          ]),
          policyFrame("europ-new", [{ at: NOW_SECONDS - 300, value: 1 }]),
          // A second scrape instance must not duplicate the activation.
          policyFrame(
            "europ-new",
            [{ at: NOW_SECONDS - 240, value: 1 }],
            "bridge-b",
          ),
        ]),
      );
    }
    return json(
      stateFrame(
        url.searchParams.get("current") === "Alerting"
          ? raisedRows
          : clearedRows,
      ),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1_000);
  vi.stubEnv("GRAFANA_QUERY_URL", "https://grafana.example");
  vi.stubEnv("GRAFANA_QUERY_TOKEN", "viewer-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/peg-monitoring/alerts", () => {
  it("pairs real transitions, collapses repeated rows, and adds policy activations", async () => {
    const fetchMock = successfulFetch();

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      from: FROM_SECONDS,
      to: NOW_SECONDS,
      events: [
        {
          id: `policy:europ-new:${NOW_SECONDS - 300}`,
          at: NOW_SECONDS - 300,
          severity: "policy",
          lead: "Policy europ-new activated",
          detail: "First observed in Mimir; activation time is approximate.",
        },
        {
          id: `state:critical-instance:raised:${NOW_SECONDS - 300}`,
          at: NOW_SECONDS - 300,
          severity: "page",
          lead: "EUROP downside critical page raised",
          detail: "Bitvavo EUR · active policy entered alerting.",
        },
        {
          id: `state:spread-instance:cleared:${NOW_SECONDS - 600}`,
          at: NOW_SECONDS - 600,
          severity: "cleared",
          lead: "EUROP spread warning cleared",
          detail:
            "Bitvavo EUR · active policy returned to normal after 10 min.",
        },
        {
          id: `state:spread-instance:raised:${NOW_SECONDS - 1_200}`,
          at: NOW_SECONDS - 1_200,
          severity: "warning",
          lead: "EUROP spread warning raised",
          detail: "Bitvavo EUR · active policy entered alerting.",
        },
      ],
    });
    expect(PEG_ALERTS_MAX_EVENTS).toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const stateCalls = fetchMock.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/api/v1/rules/history",
    );
    expect(stateCalls).toHaveLength(2);
    for (const [input, init] of stateCalls) {
      const url = new URL(String(input));
      const query = url.searchParams;
      expect(query.get("from")).toBe(String(FROM_SECONDS));
      expect(query.get("to")).toBe(String(NOW_SECONDS));
      expect(query.get("limit")).toBe(String(PEG_ALERTS_MAX_STATE_ROWS + 1));
      expect(query.get("labels_service")).toBe("peg-monitoring");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer viewer-token",
      );
    }
    expect(
      stateCalls.some(
        ([input]) =>
          new URL(String(input)).searchParams.get("current") === "Alerting",
      ),
    ).toBe(true);
    expect(
      stateCalls.some(([input]) => {
        const query = new URL(String(input)).searchParams;
        return (
          query.get("previous") === "Alerting" &&
          query.get("current") === "Normal"
        );
      }),
    ).toBe(true);

    const policyCall = fetchMock.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === "/api/ds/query",
    )!;
    const policyBody = JSON.parse(String(policyCall[1]?.body)) as {
      from: string;
      to: string;
      queries: Array<Record<string, unknown>>;
    };
    expect(policyBody.from).toBe(String(POLICY_BOUNDS.fromMs));
    expect(policyBody.to).toBe(String(POLICY_BOUNDS.toMs));
    expect(policyBody.queries).toEqual([
      expect.objectContaining({
        datasource: { type: "prometheus", uid: PEG_ALERTS_DATASOURCE_UID },
        expr: "mento_peg_policy_version",
        intervalMs: PEG_ALERTS_POLICY_STEP_SECONDS * 1_000,
        range: true,
        instant: false,
      }),
    ]);
    expect(PEG_ALERTS_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("returns the real empty state when both Grafana sources are empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/api/ds/query")
        ? json(policyResponse())
        : json(stateFrame([])),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      from: FROM_SECONDS,
      to: NOW_SECONDS,
      events: [],
    });
  });

  it("rejects missing credentials and unsafe Grafana origins before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("GRAFANA_QUERY_TOKEN", "   ");
    expect((await GET()).status).toBe(503);
    vi.stubEnv("GRAFANA_QUERY_TOKEN", "viewer-token");
    const credentialedOrigin = new URL("https://grafana.example");
    credentialedOrigin.username = "user";
    credentialedOrigin.password = "test";
    const unsafeStatuses = await Promise.all(
      [
        "http://grafana.example",
        "https://grafana.example/subpath",
        credentialedOrigin.href,
        "https://grafana.example?token=no",
      ].map((origin) => {
        vi.stubEnv("GRAFANA_QUERY_URL", origin);
        return GET().then((response) => response.status);
      }),
    );
    expect(unsafeStatuses).toEqual([503, 503, 503, 503]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for malformed frames, logical query errors, and oversized bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ schema: {}, data: {} }))
      .mockResolvedValueOnce(json(stateFrame([])))
      .mockResolvedValueOnce(json(policyResponse()));
    expect((await GET()).status).toBe(502);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(stateFrame([])))
      .mockResolvedValueOnce(json(stateFrame([])))
      .mockResolvedValueOnce(
        json({
          results: {
            P: { frames: [], error: "secret query detail", status: 500 },
          },
        }),
      );
    const logical = await GET();
    expect(logical.status).toBe(502);
    expect(JSON.stringify(await logical.json())).not.toContain(
      "secret query detail",
    );

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(PEG_ALERTS_MAX_STATE_RESPONSE_BYTES + 1),
          },
        }),
      )
      .mockResolvedValueOnce(json(stateFrame([])))
      .mockResolvedValueOnce(json(policyResponse()));
    expect((await GET()).status).toBe(502);

    expect(PEG_ALERTS_MAX_POLICY_RESPONSE_BYTES).toBeLessThan(
      PEG_ALERTS_MAX_STATE_RESPONSE_BYTES,
    );
  });

  it("fails closed when the state-history sentinel proves truncation", async () => {
    const sentinelRows = Array.from(
      { length: PEG_ALERTS_MAX_STATE_ROWS + 1 },
      (_, index) => ({
        at: FROM_SECONDS + index,
        line: stateLine({ fingerprint: `sentinel-${index}` }),
      }),
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(stateFrame(sentinelRows)))
      .mockResolvedValueOnce(json(stateFrame([])))
      .mockResolvedValueOnce(json(policyResponse()));

    expect((await GET()).status).toBe(502);
  });

  it("maps upstream timeouts to 504 without exposing credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("viewer-token", "TimeoutError"),
    );
    const response = await GET();
    expect(response.status).toBe(504);
    expect(JSON.stringify(await response.json())).not.toContain("viewer-token");
  });

  it("does not depend on a NextRequest or query parameters", async () => {
    successfulFetch();
    await expect(GET()).resolves.toBeInstanceOf(NextResponse);
  });
});
