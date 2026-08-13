import { describe, expect, it } from "vitest";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import type { PegMonitor, PegSource } from "@/lib/peg-monitoring";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
import {
  PEG_RAIL_SCALE_BPS,
  alertRulesText,
  headerAlertRules,
  boardSummary,
  boardTone,
  distanceLabelFor,
  mostSaturatedMonitor,
  railMarker,
  safeguardState,
  sortBoardRows,
  sourceDistance,
  statusBadge,
  supportingRole,
  supportingSourceUnusableReason,
  tradingLimitTooltip,
  venueLabel,
  venueTradeUrl,
  worstMonitor,
  type MonitorState,
} from "../_lib/peg-board-model";
import { checkedAgo, formatDuration } from "../_lib/peg-board-format";

const fixture = makePegMonitoringResponse();
const pkg = fixture.packages[0]!;
const primarySource = pkg.sources[0]!;
const monitor = pkg.monitors[0]!;

function asset(overrides: Partial<PegAssetPresentation>): PegAssetPresentation {
  return {
    asset: pkg,
    assetName: "EUROP",
    decisionSource: primarySource,
    deepSource: primarySource,
    structuralEvidenceCurrent: true,
    usableSourceCount: 3,
    distanceBps: 3.1,
    direction: "below",
    downsideWarningThresholdBps: 25,
    downsideCriticalThresholdBps: 50,
    premiumWarningThresholdBps: 25,
    warningThresholdBps: 25,
    warningDistanceBps: 21.9,
    thresholdTone: "healthy",
    tone: "healthy",
    currentCritical: false,
    reasons: [],
    uncertain: false,
    uncertaintyReason: null,
    ...overrides,
  };
}

describe("railMarker", () => {
  it("centres the target and maps ±60 bps onto the full track", () => {
    expect(PEG_RAIL_SCALE_BPS).toBe(60);
    expect(railMarker(0, "at target")).toEqual({
      percent: 50,
      offScale: false,
    });
    expect(railMarker(60, "below")).toEqual({ percent: 0, offScale: false });
    expect(railMarker(60, "above")).toEqual({ percent: 100, offScale: false });
    expect(railMarker(3.1, "below")?.percent).toBeCloseTo(47.42, 2);
    expect(railMarker(30, "above")?.percent).toBe(75);
  });

  it("clamps and flags deviations beyond the shared scale", () => {
    expect(railMarker(134, "below")).toEqual({ percent: 0, offScale: true });
    expect(railMarker(194, "above")).toEqual({ percent: 100, offScale: true });
  });

  it("returns nothing without a usable distance", () => {
    expect(railMarker(null, "below")).toBeNull();
    expect(railMarker(12, null)).toBeNull();
  });
});

describe("sortBoardRows", () => {
  it("puts critical then warning then healthy first, alphabetically within a tone", () => {
    const rows = sortBoardRows([
      asset({ assetName: "ZZZ" }),
      asset({ assetName: "KES", tone: "warning" }),
      asset({ assetName: "AAA" }),
      asset({ assetName: "GHS", tone: "critical", currentCritical: true }),
      asset({ assetName: "BBB", uncertain: true, uncertaintyReason: "x" }),
    ]);
    expect(rows.map((row) => row.assetName)).toEqual([
      "GHS",
      "KES",
      "BBB",
      "AAA",
      "ZZZ",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [asset({ assetName: "ZZZ" }), asset({ assetName: "AAA" })];
    sortBoardRows(input);
    expect(input.map((row) => row.assetName)).toEqual(["ZZZ", "AAA"]);
  });
});

describe("boardTone and statusBadge", () => {
  it("keeps a retained critical result critical and labels uncertainty", () => {
    expect(boardTone(asset({ tone: "critical", currentCritical: false }))).toBe(
      "critical",
    );
    expect(statusBadge(asset({ uncertain: true }))).toEqual({
      label: "Unconfirmed",
      tone: "uncertain",
    });
    expect(statusBadge(asset({ tone: "warning" })).label).toBe("Warning");
    expect(statusBadge(asset({})).label).toBe("Healthy");
  });
});

describe("venue links", () => {
  it("builds exchange trade-page URLs per provider", () => {
    expect(venueTradeUrl(primarySource)).toBe(
      "https://account.bitvavo.com/markets/EUROP-EUR",
    );
    expect(venueTradeUrl(pkg.sources[1]!)).toBe(
      "https://pro.kraken.com/app/trade/europ-eur",
    );
  });

  it("renders an unknown provider unlinked", () => {
    const unknown: PegSource = { ...primarySource, provider: "somevenue" };
    expect(venueTradeUrl(unknown)).toBeNull();
    expect(venueLabel(unknown)).toBe("Somevenue EUROP / EUR");
  });
});

describe("safeguardState", () => {
  const cases: Array<[string, PegMonitor, string]> = [
    ["ready", monitor, "Ready"],
    [
      "disabled",
      { ...monitor, breaker: { ...monitor.breaker!, enabled: false } },
      "Disabled",
    ],
    [
      "tripped",
      { ...monitor, breaker: { ...monitor.breaker!, status: "TRIPPED" } },
      "Tripped",
    ],
    ["missing breaker", { ...monitor, breaker: null }, "Unavailable"],
    [
      "unreachable pool",
      { ...monitor, indexedPoolReachable: false },
      "Unavailable",
    ],
    [
      "saturated query",
      { ...monitor, structuralQuerySaturated: true },
      "Check expired",
    ],
  ];
  it.each(cases)("labels %s", (_name, input, label) => {
    expect(safeguardState(input, true, false).label).toBe(label);
  });

  it("expires ahead of every other condition", () => {
    expect(safeguardState(monitor, false, false).label).toBe("Check expired");
  });

  it("frames a stale package as a last confirmed reading", () => {
    expect(safeguardState(monitor, true, true).detail).toContain(
      "last confirmed check",
    );
  });
});

describe("monitor selection", () => {
  const states: MonitorState[] = [
    {
      monitor,
      poolId: "137-0xaaa",
      breaker: { label: "Ready", tone: "healthy", detail: "" },
      saturation: 0.1,
    },
    {
      monitor,
      poolId: "137-0xbbb",
      breaker: { label: "Tripped", tone: "critical", detail: "" },
      saturation: 0.9,
    },
    {
      monitor,
      poolId: "137-0xccc",
      breaker: { label: "Disabled", tone: "warning", detail: "" },
      saturation: null,
    },
  ];

  it("picks the worst breaker and the most saturated limit", () => {
    expect(worstMonitor(states)?.poolId).toBe("137-0xbbb");
    expect(mostSaturatedMonitor(states)?.poolId).toBe("137-0xbbb");
    expect(worstMonitor([])).toBeNull();
    expect(mostSaturatedMonitor([])).toBeNull();
  });
});

describe("headerAlertRules", () => {
  const presentation = (
    assets: PegAssetPresentation[],
  ): Parameters<typeof headerAlertRules>[0] =>
    ({ assets }) as Parameters<typeof headerAlertRules>[0];

  it("collapses uniform policies to one shared copy", () => {
    const rules = headerAlertRules(
      presentation([asset({}), asset({ assetName: "GHSm" })]),
    );
    expect(rules.cadence).toBe("Checks every 30s");
    expect(rules.tooltipLabel).toBe("Alert rules (all pegs)");
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0]!.label).toBeNull();
  });

  it("labels each peg and shows a cadence range when policies diverge", () => {
    const otherPolicy = { ...pkg.policy, criticalDeviationBps: 75 };
    const otherSource = {
      ...primarySource,
      policy: { ...primarySource.policy, pollIntervalSeconds: 60 },
    };
    const rules = headerAlertRules(
      presentation([
        // Critical row sorts first in the table; the header must still list
        // alphabetically, so ZZZ's severity must not put it first here.
        asset({
          assetName: "ZZZ",
          tone: "critical",
          currentCritical: true,
          asset: { ...pkg, policy: otherPolicy },
          deepSource: otherSource,
        }),
        asset({}),
      ]),
    );
    expect(rules.tooltipLabel).toBe("Alert rules per peg");
    expect(rules.cadence).toBe("Checks every 30s–1m");
    expect(rules.rules.map((rule) => rule.label)).toEqual([
      "EUROP / EUR",
      "ZZZ / EUR",
    ]);
    expect(rules.rules[1]!.text).toContain("75 bps");
  });

  it("keeps the single-peg label", () => {
    const rules = headerAlertRules(presentation([asset({})]));
    expect(rules.tooltipLabel).toBe("Alert rules for this peg");
    expect(rules.rules[0]!.label).toBeNull();
  });
});

describe("policy-derived copy", () => {
  it("interpolates thresholds, windows and coverage instead of hardcoding", () => {
    expect(alertRulesText(pkg.policy, 30)).toBe(
      "Checks run every 30 seconds. Warning: price ≥ 25 bps below target (or ≥ 25 bps above) for 80% of checks over 10 minutes — alerts the team in Slack. Critical page: ≥ 50 bps below for 20 minutes — pages the on-call engineer.",
    );
  });

  it("tracks a different policy", () => {
    const text = alertRulesText(
      {
        ...pkg.policy,
        warnDeviationBps: 40,
        criticalDeviationBps: 90,
        warnSustainSeconds: 300,
        criticalSustainSeconds: 3_600,
      },
      60,
    );
    expect(text).toContain("≥ 40 bps below target");
    expect(text).toContain("over 5 minutes");
    expect(text).toContain("≥ 90 bps below for 1 hour");
    expect(text).toContain("Checks run every 1 minute.");
  });

  it("names the window pair the payload rolls up", () => {
    expect(tradingLimitTooltip(0.8)).toContain(
      "the maximum across the pool's 5-minute and 24-hour windows",
    );
    expect(tradingLimitTooltip(0.8)).toContain("Warns at 80% of the limit.");
  });

  it("formats policy durations", () => {
    expect(formatDuration(30)).toBe("30 seconds");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(1_200)).toBe("20 minutes");
    expect(formatDuration(7_200)).toBe("2 hours");
  });
});

describe("supporting markets", () => {
  it("tags a converted feed as display only and names the feed", () => {
    const role = supportingRole(pkg.sources[2]!);
    expect(role.tag).toBe("DISPLAY ONLY");
    expect(role.tooltip).toBe(
      "Quoted in USD and converted to EUR via the EUR/USD feed. Shown purely for context — it influences neither peg status nor alerts.",
    );
  });

  it("explains a thin book with its own fill fraction", () => {
    const thin: PegSource = {
      ...pkg.sources[1]!,
      capped: true,
      filledFraction: 0.37,
    };
    const role = supportingRole(thin);
    expect(role.tag).toBe("DEPTH ONLY");
    expect(role.tooltip).toContain(
      "order book is too thin to absorb the 50,000 EUROP test sale (only ~37% fills)",
    );
  });

  it("does not claim a thin book when the venue fills the test sale", () => {
    const role = supportingRole(pkg.sources[1]!);
    expect(role.tag).toBe("DEPTH ONLY");
    expect(role.tooltip).not.toContain("too thin");
    expect(role.tooltip).toContain("can never set peg status");
  });

  it("keeps a capped-but-fresh venue usable and blocks invalid evidence", () => {
    const fresh = pkg.sources[1]!;
    const at = (fresh.observationAt ?? 0) * 1_000 + 5_000;
    expect(supportingSourceUnusableReason(fresh, at)).toBeNull();
    expect(
      supportingSourceUnusableReason({ ...fresh, capped: true }, at),
    ).toBeNull();
    expect(
      supportingSourceUnusableReason({ ...fresh, healthy: false }, at),
    ).toBe("no healthy observation");
    // Schema-valid degraded fixtures: halted/absent listings and halted venues
    // are always non-healthy too, and the specific reason must still surface.
    expect(
      supportingSourceUnusableReason(
        { ...fresh, healthy: false, venueState: "halted" },
        at,
      ),
    ).toBe("venue halted");
    expect(
      supportingSourceUnusableReason(
        { ...fresh, healthy: false, listingState: "halted" },
        at,
      ),
    ).toBe("listing halted");
    expect(
      supportingSourceUnusableReason(
        { ...fresh, healthy: false, listingState: "absent" },
        at,
      ),
    ).toBe("not listed on this venue");
    // A capped observation can retain healthy=true with no executable price.
    expect(
      supportingSourceUnusableReason({ ...fresh, executablePrice: null }, at),
    ).toBe("no current observation");
    expect(
      supportingSourceUnusableReason(
        fresh,
        at + fresh.policy.staleAfterSeconds * 1_000 + 1_000,
      ),
    ).toBe("check expired");
  });

  it("derives a signed distance from the venue's own price", () => {
    const kraken = sourceDistance(pkg.sources[1]!, 1);
    expect(kraken.direction).toBe("below");
    expect(kraken.bps).toBeCloseTo(32, 6);
    expect(sourceDistance({ ...primarySource, executablePrice: 1 }, 1)).toEqual(
      {
        bps: 0,
        direction: "at target",
      },
    );
    expect(
      sourceDistance({ ...primarySource, executablePrice: null }, 1).direction,
    ).toBeNull();
  });
});

describe("board summary", () => {
  it("counts healthy pegs and carries the aggregate verdict", () => {
    expect(
      boardSummary({
        assets: [asset({}), asset({ tone: "warning" })],
        aggregate: {
          tone: "warning",
          label: "Some pegs need attention",
          detail: "EUROP crossed a warning threshold.",
        },
        furthest: null,
        closestWarning: null,
      }),
    ).toEqual({
      text: "1 of 2 pegs healthy · 1 warning",
      tone: "warning",
      ariaLabel: "Some pegs need attention. EUROP crossed a warning threshold.",
    });
  });

  it("appends the uncertain verdict so a stale package stays visible", () => {
    expect(
      boardSummary({
        assets: [asset({ uncertain: true })],
        aggregate: {
          tone: "uncertain",
          label: "Latest data is stale",
          detail: null,
        },
        furthest: null,
        closestWarning: null,
      }).text,
    ).toBe("0 of 1 peg healthy · 1 unconfirmed · latest data is stale");
  });
});

describe("cell formatting", () => {
  it("labels distances and missing prices", () => {
    expect(distanceLabelFor(3.14, "below")).toBe("3.1 bps below");
    expect(distanceLabelFor(0.01, "below")).toBe("<0.1 bps below");
    expect(distanceLabelFor(0, "at target")).toBe("At target");
    expect(distanceLabelFor(null, null)).toBe("Price unavailable");
  });

  it("ticks per-cell ages from the browser clock", () => {
    const now = fixture.producedAt * 1_000 + 29_000;
    expect(checkedAgo(fixture.producedAt, now)).toBe("checked 29s ago");
    expect(checkedAgo(null, now)).toBeNull();
  });
});
