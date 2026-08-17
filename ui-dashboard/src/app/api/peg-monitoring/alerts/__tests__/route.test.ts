import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PegAlertEvent,
  PEG_ALERTS_WINDOW_SECONDS,
} from "@/lib/peg-alerts";
import {
  GET,
  PEG_ALERTS_MAX_EVENTS,
  PEG_ALERTS_MAX_STATE_RESPONSE_BYTES,
  PEG_ALERTS_UPSTREAM_TIMEOUT_MS,
} from "../route";
import {
  combinePegAlertEvents,
  parseStateTransitions,
  PEG_ALERTS_MAX_STATE_ROWS,
} from "../peg-alert-events";

const NOW_SECONDS = 1_786_694_595;
const FROM_SECONDS = NOW_SECONDS - PEG_ALERTS_WINDOW_SECONDS;

type StateLine = {
  schemaVersion: 1;
  previous: string;
  current: string;
  fingerprint: string;
  ruleTitle: string;
  ruleUID: string;
  values: Record<string, number>;
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
    values: { A: 34, Reason: 0, HttpStatus: 0 },
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

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function eventFor(overrides: Parameters<typeof stateLine>[0]): PegAlertEvent {
  const transitions = parseStateTransitions(
    stateFrame([{ at: NOW_SECONDS - 1, line: stateLine(overrides) }]),
    FROM_SECONDS,
    NOW_SECONDS,
  );
  const event = combinePegAlertEvents(transitions, 1)[0];
  if (event === undefined) throw new Error("missing alert event");
  return event;
}

function successfulFetch() {
  const raisedRows = [
    { at: NOW_SECONDS - 1_200, line: stateLine() },
    { at: NOW_SECONDS - 1_140, line: stateLine() },
    {
      at: NOW_SECONDS - 300,
      line: stateLine({
        fingerprint: "critical-instance",
        ruleTitle: "Peg Deep-Venue Downside Critical [europ-schuman · active]",
        ruleUID: "critical-rule",
        values: { A: 52, Reason: 0, HttpStatus: 0 },
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
  const normalRows = [
    {
      at: NOW_SECONDS - 600,
      line: stateLine({ previous: "Alerting", current: "Normal", values: {} }),
    },
    {
      at: NOW_SECONDS - 540,
      line: stateLine({ previous: "Alerting", current: "Normal", values: {} }),
    },
    {
      at: NOW_SECONDS - 120,
      line: stateLine({
        previous: "Alerting",
        current: "Normal",
        fingerprint: "unpaired-instance",
        values: {},
      }),
    },
  ];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const current = url.searchParams.get("current");
    const previous = url.searchParams.get("previous");
    return json(
      stateFrame(
        current === "Alerting"
          ? raisedRows
          : previous === "Alerting"
            ? normalRows
            : [],
      ),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1_000);
  vi.stubEnv("GRAFANA_QUERY_URL", "https://grafana.example");
  vi.stubEnv("GRAFANA_QUERY_TOKEN", "test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/peg-monitoring/alerts", () => {
  it("pairs transitions, keeps original evidence, and omits policy activations", async () => {
    const fetchMock = successfulFetch();

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      from: FROM_SECONDS,
      to: NOW_SECONDS,
      events: [
        {
          id: `state:unpaired-instance:cleared:${NOW_SECONDS - 120}`,
          at: NOW_SECONDS - 120,
          severity: "cleared",
          lead: "Bitvavo buy and sell prices were unusually far apart",
          detail: "EUROP.",
          evidence: {
            rule: "Deep-Venue Spread Warning",
            assetId: "europ-schuman",
            assetName: "EUROP",
            sourceId: "bitvavo_eur",
            sourceName: "Bitvavo",
            quoteCurrency: "EUR",
            policyVersion: "europ-v1",
            failureReason: null,
          },
        },
        {
          id: `state:critical-instance:raised:${NOW_SECONDS - 300}`,
          at: NOW_SECONDS - 300,
          severity: "page",
          lead: "Bitvavo sell price is 52 bps below peg",
          detail: "EUROP.",
          evidence: {
            rule: "Deep-Venue Downside Critical",
            assetId: "europ-schuman",
            assetName: "EUROP",
            sourceId: "bitvavo_eur",
            sourceName: "Bitvavo",
            quoteCurrency: "EUR",
            policyVersion: "europ-v1",
            failureReason: null,
          },
        },
        {
          id: `state:spread-instance:cleared:${NOW_SECONDS - 600}`,
          at: NOW_SECONDS - 600,
          severity: "cleared",
          lead: "Bitvavo buy and sell prices were 34 bps apart",
          detail: "EUROP · lasted 10 min.",
          evidence: {
            rule: "Deep-Venue Spread Warning",
            assetId: "europ-schuman",
            assetName: "EUROP",
            sourceId: "bitvavo_eur",
            sourceName: "Bitvavo",
            quoteCurrency: "EUR",
            policyVersion: "europ-v1",
            failureReason: null,
          },
        },
        {
          id: `state:spread-instance:raised:${NOW_SECONDS - 1_200}`,
          at: NOW_SECONDS - 1_200,
          severity: "warning",
          lead: "Bitvavo buy and sell prices are 34 bps apart",
          detail: "EUROP.",
          evidence: {
            rule: "Deep-Venue Spread Warning",
            assetId: "europ-schuman",
            assetName: "EUROP",
            sourceId: "bitvavo_eur",
            sourceName: "Bitvavo",
            quoteCurrency: "EUR",
            policyVersion: "europ-v1",
            failureReason: null,
          },
        },
      ],
    });
    expect(PEG_ALERTS_MAX_EVENTS).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("current"),
      ),
    ).toEqual(["Alerting", "Normal"]);
    expect(
      fetchMock.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("previous"),
      ),
    ).toEqual([null, "Alerting"]);
    for (const [input, init] of fetchMock.mock.calls) {
      const query = new URL(String(input)).searchParams;
      expect(query.get("from")).toBe(String(FROM_SECONDS));
      expect(query.get("to")).toBe(String(NOW_SECONDS));
      expect(query.get("limit")).toBe(String(PEG_ALERTS_MAX_STATE_ROWS + 1));
      expect(query.get("labels_service")).toBe("peg-monitoring");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
    }
    expect(PEG_ALERTS_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("does not read high-cardinality Pending state history", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const query = new URL(String(input)).searchParams;
        if (
          query.get("current") === "Pending" ||
          query.get("previous") === "Pending"
        )
          throw new Error("Pending state history exceeded 1,000 rows");
        return json(stateFrame([]));
      });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      from: FROM_SECONDS,
      to: NOW_SECONDS,
      events: [],
    });
  });

  it("coalesces matching active and previous policy transitions", () => {
    const active = stateLine({
      fingerprint: "active",
      values: { A: 31 },
    });
    const previous = stateLine({
      fingerprint: "previous",
      ruleTitle:
        "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · previous]",
      labels: {
        alertname:
          "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · previous]",
        policy_version: "europ-old",
      },
      values: { A: 32 },
    });
    const transitions = parseStateTransitions(
      stateFrame([
        { at: NOW_SECONDS - 61, line: previous },
        { at: NOW_SECONDS - 1, line: active },
      ]),
      FROM_SECONDS,
      NOW_SECONDS,
    );

    expect(combinePegAlertEvents(transitions, 4)).toEqual([
      expect.objectContaining({
        id: `state:active:raised:${NOW_SECONDS - 1}`,
        lead: "Bitvavo buy and sell prices are 31 bps apart",
      }),
    ]);
  });

  it("keeps separate alert cycles from the same policy", () => {
    const fired = stateLine({ fingerprint: "active-cycle" });
    const resolved = stateLine({
      previous: "Alerting",
      current: "Normal",
      fingerprint: "active-cycle",
      values: {},
    });
    const transitions = parseStateTransitions(
      stateFrame([
        { at: NOW_SECONDS - 200, line: fired },
        { at: NOW_SECONDS - 160, line: resolved },
        { at: NOW_SECONDS - 120, line: fired },
        { at: NOW_SECONDS - 80, line: resolved },
      ]),
      FROM_SECONDS,
      NOW_SECONDS,
    );

    expect(combinePegAlertEvents(transitions, 4).map(({ id }) => id)).toEqual([
      `state:active-cycle:cleared:${NOW_SECONDS - 80}`,
      `state:active-cycle:raised:${NOW_SECONDS - 120}`,
      `state:active-cycle:cleared:${NOW_SECONDS - 160}`,
      `state:active-cycle:raised:${NOW_SECONDS - 200}`,
    ]);
  });

  it("keeps only the latest resolution when its fire predates the window", () => {
    const firstResolved = stateLine({
      previous: "Alerting",
      current: "Normal",
      fingerprint: "boundary-resolution",
      values: {},
    });
    const latestResolved = stateLine({
      previous: "Alerting",
      current: "Normal",
      fingerprint: "boundary-resolution",
      values: {},
    });
    const transitions = parseStateTransitions(
      stateFrame([
        { at: NOW_SECONDS - 100, line: firstResolved },
        { at: NOW_SECONDS - 80, line: latestResolved },
      ]),
      FROM_SECONDS,
      NOW_SECONDS,
    );

    expect(combinePegAlertEvents(transitions, 4)).toEqual([
      expect.objectContaining({
        id: `state:boundary-resolution:cleared:${NOW_SECONDS - 80}`,
        severity: "cleared",
        lead: "Bitvavo buy and sell prices were unusually far apart",
        detail: "EUROP.",
      }),
    ]);
  });

  it("ignores transitions that never fired", () => {
    const pending = stateLine({
      previous: "Normal",
      current: "Pending",
      fingerprint: "canceled-pending",
    });
    const canceled = stateLine({
      previous: "Pending",
      current: "Normal",
      fingerprint: "canceled-pending",
      values: {},
    });
    const transitions = parseStateTransitions(
      stateFrame([
        { at: NOW_SECONDS - 200, line: pending },
        { at: NOW_SECONDS - 150, line: canceled },
      ]),
      FROM_SECONDS,
      NOW_SECONDS,
    );
    expect(combinePegAlertEvents(transitions, 4)).toEqual([]);
  });

  it("coalesces active and previous policy transitions one-to-one", () => {
    const active = stateLine({ fingerprint: "active" });
    const previous = (fingerprint: string) =>
      stateLine({
        fingerprint,
        ruleTitle:
          "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · previous]",
        labels: {
          alertname:
            "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · previous]",
          policy_version: "europ-old",
        },
      });
    const transitions = parseStateTransitions(
      stateFrame([
        { at: NOW_SECONDS - 120, line: previous("previous-older") },
        { at: NOW_SECONDS - 90, line: active },
        { at: NOW_SECONDS - 60, line: previous("previous-newer") },
      ]),
      FROM_SECONDS,
      NOW_SECONDS,
    );

    expect(combinePegAlertEvents(transitions, 4).map(({ id }) => id)).toEqual([
      `state:active:raised:${NOW_SECONDS - 90}`,
      `state:previous-older:raised:${NOW_SECONDS - 120}`,
    ]);
  });

  it.each([
    {
      title: "Peg Downside Warning [europ-schuman/bitvavo_eur · active]",
      values: { A: 31 },
      lead: "Bitvavo sell price is 31 bps below peg",
    },
    {
      title: "Peg Downside Warning [kesm-current/valr_zar · active]",
      values: { A: 25 },
      source: "valr_zar",
      asset: "kesm-current",
      lead: "VALR sell price is 25 bps below peg",
    },
    {
      title: "Peg Premium Warning [europ-schuman/bitvavo_eur · active]",
      values: { A: 26.4 },
      lead: "Bitvavo sell price is 26.4 bps above peg",
    },
    {
      title:
        "Peg Deep-Venue Spread Warning [europ-schuman/bitvavo_eur · active]",
      values: { A: 34 },
      lead: "Bitvavo buy and sell prices are 34 bps apart",
    },
    {
      title: "Peg Structural Saturation Warning [europ-schuman · active]",
      values: { Structural: 82.5 },
      source: "",
      lead: "EUROP pool flow is using 82.5% of its trading limit",
    },
    {
      title: "Peg Registry Rot [europ-schuman/kraken_usd · active]",
      values: {},
      source: "kraken_usd",
      lead: "Kraken does not list the EUROP/USD market",
    },
    {
      title: "Peg Indexed Pool Unreachable [europ-schuman · active]",
      values: { Reason: 12 },
      source: "",
      lead: "EUROP pool data cannot be fetched",
    },
    {
      title: "Peg Heartbeat Missing [europ-schuman · active]",
      values: {},
      source: "",
      lead: "EUROP monitor data has stopped updating",
    },
    {
      title: "Peg Policy Rollover Stuck",
      values: {},
      source: "",
      asset: "policy",
      lead: "Peg monitor has not loaded policy europ-v1",
    },
  ])(
    "uses cause-first copy for $title",
    ({ title, values, source, asset, lead }) => {
      const event = eventFor({
        ruleTitle: title,
        values,
        labels: {
          alertname: title,
          source: source ?? "bitvavo_eur",
          asset: asset ?? "europ-schuman",
        },
      });
      expect(event.lead).toBe(lead);
      expect(event.lead).not.toMatch(
        /warning|raised|cleared|alerting|blindness|critical page/i,
      );
    },
  );

  it.each([
    [
      1,
      429,
      "Bitvavo is rejecting price requests because its rate limit is reached (HTTP 429)",
    ],
    [2, 500, "Bitvavo price request returns HTTP 500"],
    [3, 0, "Bitvavo price request is timing out"],
    [4, 0, "Bitvavo cannot be reached"],
    [5, 0, "Bitvavo is returning invalid price data"],
    [6, 0, "Bitvavo price data is too old"],
    [7, 0, "Bitvavo is repeating old price data"],
    [
      8,
      0,
      "Bitvavo cannot fill the monitored sell size; only 42% is available",
    ],
    [9, 0, "Bitvavo market is halted"],
    [10, 0, "Bitvavo price cannot be converted to the peg currency"],
    [11, 0, "Bitvavo price conversion is failing"],
    [16, 0, "Pool data does not provide the monitored sell size"],
    [17, 0, "Bitvavo is not supported by the monitor"],
    [18, 0, "Bitvavo sell price is unavailable"],
    [19, 0, "Multiple failures are preventing a usable Bitvavo price"],
    [20, 0, "Bitvavo does not list this market"],
  ])(
    "explains bounded source failure reason %i",
    (reason, status, expectedLead) => {
      const title = "Peg Source Unhealthy [europ-schuman/bitvavo_eur · active]";
      const event = eventFor({
        ruleTitle: title,
        values: { Reason: reason, HttpStatus: status, Fill: 42 },
        labels: { alertname: title },
      });
      expect(event).toMatchObject({
        lead: expectedLead,
        detail: "EUROP.",
      });
    },
  );

  it("keeps the fired HTTP cause when the alert resolves", () => {
    const title = "Peg Source Unhealthy [europ-schuman/bitvavo_eur · active]";
    const fired = stateLine({
      fingerprint: "rate-limit-instance",
      ruleTitle: title,
      values: { Reason: 1, HttpStatus: 429 },
      labels: { alertname: title },
    });
    const resolved = stateLine({
      previous: "Alerting",
      current: "Normal",
      fingerprint: "rate-limit-instance",
      ruleTitle: title,
      values: {},
      labels: { alertname: title },
    });
    const events = combinePegAlertEvents(
      parseStateTransitions(
        stateFrame([
          { at: NOW_SECONDS - 120, line: fired },
          { at: NOW_SECONDS - 60, line: resolved },
        ]),
        FROM_SECONDS,
        NOW_SECONDS,
      ),
      4,
    );

    expect(events[0]).toMatchObject({
      severity: "cleared",
      lead: "Bitvavo rejected price requests because its rate limit was reached (HTTP 429)",
      detail: "EUROP · lasted 1 min.",
    });
  });

  it("uses positive recovery wording for stale and unclassified prices", () => {
    const title = "Peg Source Unhealthy [europ-schuman/kraken_eur · active]";
    const fired = stateLine({
      fingerprint: "stale-instance",
      ruleTitle: title,
      values: { Reason: 6 },
      labels: { alertname: title, source: "kraken_eur" },
    });
    const resolved = stateLine({
      previous: "Alerting",
      current: "Normal",
      fingerprint: "stale-instance",
      ruleTitle: title,
      values: {},
      labels: { alertname: title, source: "kraken_eur" },
    });
    const events = combinePegAlertEvents(
      parseStateTransitions(
        stateFrame([
          { at: NOW_SECONDS - 120, line: fired },
          { at: NOW_SECONDS - 60, line: resolved },
        ]),
        FROM_SECONDS,
        NOW_SECONDS,
      ),
      4,
    );

    expect(events).toEqual([
      expect.objectContaining({
        severity: "cleared",
        lead: "Kraken price data is fresh again",
        evidence: expect.objectContaining({
          failureReason: 6,
        }),
      }),
      expect.objectContaining({
        severity: "warning",
        lead: "Kraken price data is too old",
        evidence: expect.objectContaining({
          failureReason: 6,
        }),
      }),
    ]);

    expect(
      eventFor({
        ruleTitle: title,
        values: { Reason: 18 },
        labels: { alertname: title, source: "kraken_eur" },
      }).lead,
    ).toBe("Kraken sell price is unavailable");
  });

  it("adds the separate stress cause without policy jargon", () => {
    const title = "Peg Blind While Stressed Critical [europ-schuman · active]";
    expect(
      eventFor({
        ruleTitle: title,
        values: { Reason: 8, Fill: 42 },
        labels: { alertname: title, route: "page", severity: "critical" },
      }).lead,
    ).toBe(
      "Bitvavo cannot fill the monitored sell size; only 42% is available while separate market data also shows stress",
    );
  });

  it("returns an empty state when Grafana has no transitions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(stateFrame([])),
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
    vi.stubEnv("GRAFANA_QUERY_TOKEN", "test-token");
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
        return GET().then((result) => result.status);
      }),
    );
    expect(unsafeStatuses).toEqual([503, 503, 503, 503]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for malformed frames and oversized bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ schema: {}, data: {} }))
      .mockResolvedValueOnce(json(stateFrame([])));
    expect((await GET()).status).toBe(502);

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
      .mockResolvedValueOnce(json(stateFrame([])));
    expect((await GET()).status).toBe(502);
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
      .mockResolvedValueOnce(json(stateFrame([])));

    expect((await GET()).status).toBe(502);
  });

  it("maps upstream timeouts to 504 without exposing credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("test-token", "TimeoutError"),
    );
    const response = await GET();
    expect(response.status).toBe(504);
    expect(JSON.stringify(await response.json())).not.toContain("test-token");
  });

  it("does not depend on a NextRequest or query parameters", async () => {
    successfulFetch();
    await expect(GET()).resolves.toBeInstanceOf(NextResponse);
  });
});
