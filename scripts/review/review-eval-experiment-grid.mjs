// The experiment grid: the fixtures the panel holds, the lanes they expand
// into, and the thresholds they derive.
//
// Every bar here is a function of the grid the contract carries and the draws
// the plan asks for. Nothing is written as a literal count, so a fixture that
// joins the grid moves the bar with the evidence instead of leaving one
// calibrated for three fixtures and a single draw.

import { gridFixtures } from "./review-eval-fixtures.mjs";

/** The grid is any size from this up; only concurrency is capped. */
export const MIN_GRID_FIXTURES = 3;
export const DEFAULT_DRAWS = 1;
/**
 * The most draws one campaign may plan. Every draw multiplies the paid cells,
 * so this is a spend guard: a wider panel is bought with more fixtures rather
 * than with more repeats of one fixture.
 */
export const MAX_DRAWS = 5;
/** The screen reads report 0 and the holdout report 1 of each fixture. */
const REPORTS_PER_FIXTURE = 2;
const KNOWN_NET_RATE = 0.06;
const SCREEN_KNOWN_NET_FLOOR = 2;
const COMBINED_KNOWN_NET_FLOOR = 3;
const CANDIDATE_P1_RATIO = 0.75;
const P1_NET_DIVISOR = 6;
const P1_NET_FLOOR = 2;
const WRONG_CLAIM_DELTA_MAX = 1;
const CLAIM_INFLATION = Object.freeze({
  absolute_delta_min: 3,
  ratio_min: 1.25,
});

export function experimentDraws(draws = DEFAULT_DRAWS) {
  if (!Number.isSafeInteger(draws) || draws < 1 || draws > MAX_DRAWS) {
    throw new Error(`draws must be an integer 1..${MAX_DRAWS}`);
  }
  return draws;
}

/**
 * Every grid fixture the contract carries, by PR number. The lane takes the
 * grid as it stands rather than a pinned PR list: a fixture added to the grid
 * joins the panel, and the derived thresholds move with it.
 */
export function experimentFixtures(contract) {
  const fixtures = gridFixtures(contract).sort(
    (left, right) => left.pr - right.pr,
  );
  if (fixtures.length < MIN_GRID_FIXTURES) {
    throw new Error(
      `experiment requires at least ${MIN_GRID_FIXTURES} grid fixtures, got ${fixtures.length}`,
    );
  }
  for (const fixture of fixtures) {
    if ((fixture.finder_reports ?? []).length < REPORTS_PER_FIXTURE) {
      throw new Error(`PR ${fixture.pr} requires two frozen finder reports`);
    }
  }
  return fixtures;
}

function idCount(fixture, field, allowEmpty) {
  const ids = fixture?.[field];
  if (!Array.isArray(ids) || (ids.length === 0 && !allowEmpty)) {
    throw new Error(`PR ${fixture?.pr} has no usable ${field}`);
  }
  return ids.length;
}

/**
 * Every threshold this campaign judges on, derived from its own panel.
 *
 * A grid fixture has to freeze a scorable defect to be worth a lane, but it may
 * freeze no P1 defect: a PR whose findings are all below P1 still measures
 * recall. Such a fixture adds zero P1 opportunities, and a grid with none at
 * all runs with every P1 bar at zero rather than with a gate that no candidate
 * could pass.
 */
export function experimentPolicy({ fixtures, draws = DEFAULT_DRAWS }) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("experiment policy needs at least one fixture");
  }
  const drawCount = experimentDraws(draws);
  const scorable = fixtures.reduce(
    (total, fixture) => total + idCount(fixture, "scorable_ids", false),
    0,
  );
  const p1 =
    fixtures.reduce(
      (total, fixture) => total + idCount(fixture, "p1_ids", true),
      0,
    ) *
    REPORTS_PER_FIXTURE *
    drawCount;
  const halfThePanel = Math.ceil(fixtures.length / 2);
  const netBar = (floor, reports) =>
    Math.max(
      floor,
      Math.round(KNOWN_NET_RATE * scorable * drawCount * reports),
    );
  return {
    draws: drawCount,
    opportunities: {
      prs: fixtures.length,
      scorable_opportunities: scorable,
      p1_opportunities: p1,
    },
    screen: {
      known_net_min: netBar(SCREEN_KNOWN_NET_FLOOR, 1),
      // No net P1 loss. The screen never asks a candidate to gain P1 defects.
      p1_net_min: 0,
      nonnegative_prs_min: halfThePanel,
    },
    combined: {
      known_net_min: netBar(COMBINED_KNOWN_NET_FLOOR, REPORTS_PER_FIXTURE),
      candidate_p1_min: p1 === 0 ? 0 : Math.round(CANDIDATE_P1_RATIO * p1),
      p1_opportunities: p1,
      p1_net_min:
        p1 === 0 ? 0 : Math.max(P1_NET_FLOOR, Math.round(p1 / P1_NET_DIVISOR)),
      gaining_prs_min: halfThePanel,
      nonnegative_prs_min: halfThePanel,
      wrong_claim_delta_max: WRONG_CLAIM_DELTA_MAX,
    },
    claim_inflation: { ...CLAIM_INFLATION },
  };
}

/**
 * A is the incumbent. B is the candidate. Order alternates on the parity of the
 * fixture and the draw together, so a fixture that ran the incumbent first on
 * draw 0 runs it second on draw 1 and arm order cannot ride along with one
 * fixture across the campaign.
 */
export function treatmentOrder({
  fixtureIndex,
  drawIndex = 0,
  candidateIndex = 0,
}) {
  if (candidateIndex !== 0) {
    throw new Error("one-candidate campaigns use candidateIndex 0");
  }
  for (const [label, value] of [
    ["fixtureIndex", fixtureIndex],
    ["drawIndex", drawIndex],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
  }
  return (fixtureIndex + drawIndex) % 2 === 0 ? "AB" : "BA";
}

function laneFixture(fixture) {
  return {
    first_head: fixture.first_head,
    base_sha: fixture.base_sha,
    truth_file: fixture.truth_file,
    truth_sha256: fixture.truth_sha256,
    scorable_ids: [...fixture.scorable_ids],
    p1_ids: [...fixture.p1_ids],
  };
}

function stageSource({ stage, fixture, finderIdentity }) {
  if (stage === "live-paired") {
    return {
      kind: "live-finder",
      finder_id: `live-pr-${fixture.pr}`,
      shared: true,
      finder_argv_digest: finderIdentity,
    };
  }
  const reportIndex = stage === "screen" ? 0 : 1;
  const report = fixture.finder_reports[reportIndex];
  return {
    kind: "frozen-report",
    report_index: reportIndex,
    file: report.file,
    sha256: report.sha256,
  };
}

/**
 * One lane per fixture per draw. Every draw of a lane replays the same frozen
 * report through both arms, so a difference between two draws is verifier
 * variance and nothing else.
 */
export function stageLanes({ stage, fixtures, draws, finderIdentity }) {
  return fixtures.flatMap((fixture, fixtureIndex) =>
    Array.from({ length: draws }, (_unused, index) => {
      const pairedOrder = treatmentOrder({ fixtureIndex, drawIndex: index });
      return {
        lane_id: `${stage}-pr-${fixture.pr}-d${index}`,
        pr: fixture.pr,
        draw: index,
        paired_order: pairedOrder,
        fixture: laneFixture(fixture),
        source: stageSource({ stage, fixture, finderIdentity }),
        sequence:
          pairedOrder === "AB"
            ? ["incumbent", "candidate"]
            : ["candidate", "incumbent"],
      };
    }),
  );
}
