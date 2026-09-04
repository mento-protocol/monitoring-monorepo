// Derived thresholds and the paired sign-flip test for the experiment lane.
//
// Every threshold here is a function of the grid the contract carries and the
// number of draws the plan asks for. Nothing is written as a literal count, so
// adding a grid fixture or a draw moves the bar with the evidence instead of
// leaving a bar that was calibrated for three fixtures and one draw.

import { createHash } from "node:crypto";

/**
 * One-sided significance for the paired sign-flip test.
 *
 * The test runs at every panel width: the alpha is the only gate, and a narrow
 * panel fails it on its own arithmetic. Four same-direction informative pairs
 * are the first width that can reach it, at 1/16; three reach only 1/8.
 */
export const PERMUTATION_ALPHA = 0.1;
/** Up to this many informative pairs every flip is enumerated. */
export const EXACT_FLIP_MAX_PAIRS = 20;
/** The widest exact enumeration this test will attempt: 2**25 assignments. */
export const EXACT_FLIP_WIDTH_LIMIT = 25;
/** Deterministic pseudo-random flips used above that width. */
export const PERMUTATION_SAMPLES = 20_000;
/** The screen reads report 0 and the holdout report 1 of each fixture. */
export const PAIRED_REPORTS_PER_FIXTURE = 2;

const KNOWN_NET_RATE = 0.06;
const SCREEN_KNOWN_NET_FLOOR = 2;
const COMBINED_KNOWN_NET_FLOOR = 3;
/** The reject bound is derived from this rate and floor at BOTH stages. */
const REJECT_KNOWN_NET_FLOOR = SCREEN_KNOWN_NET_FLOOR;
const CANDIDATE_P1_RATIO = 0.75;
const P1_NET_RATE = 1 / 6;
const P1_NET_FLOOR = 2;
const WRONG_CLAIM_DELTA_MAX = 1;
const CLAIM_INFLATION = Object.freeze({
  absolute_delta_min: 3,
  ratio_min: 1.25,
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function idCount(fixture, field, { allowEmpty = false } = {}) {
  const ids = fixture?.[field];
  if (!Array.isArray(ids)) {
    throw new Error(`PR ${fixture?.pr} ${field} must be an array`);
  }
  if (ids.length === 0 && !allowEmpty) {
    throw new Error(`PR ${fixture?.pr} has no ${field}`);
  }
  return ids.length;
}

/**
 * What the grid puts on the table, per draw for known defects and in total for
 * P1 defects. The two are counted differently because the screen bar is a rate
 * on one draw's opportunities while the P1 bars read the whole paired panel.
 *
 * A grid fixture has to freeze at least one scorable defect to be worth a lane,
 * but it may freeze no P1 defect at all: a PR whose findings are all below P1
 * still measures recall. Such a fixture contributes zero P1 opportunities, and
 * the P1 bars are then the rest of the panel's. Refusing it here would keep a
 * whole PR off the grid over a severity it never claimed.
 */
export function experimentOpportunities(fixtures, draws = 1) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("experiment opportunities need at least one fixture");
  }
  positiveInteger(draws, "draws");
  const scorable = fixtures.reduce(
    (total, fixture) => total + idCount(fixture, "scorable_ids"),
    0,
  );
  const p1 = fixtures.reduce(
    (total, fixture) =>
      total + idCount(fixture, "p1_ids", { allowEmpty: true }),
    0,
  );
  return {
    prs: fixtures.length,
    draws,
    reports_per_fixture: PAIRED_REPORTS_PER_FIXTURE,
    scorable_opportunities: scorable,
    p1_opportunities: p1 * PAIRED_REPORTS_PER_FIXTURE * draws,
  };
}

/**
 * How large a paired loss this panel is willing to call a regression.
 *
 * It is derived from the rate and the screen floor at both stages rather than
 * from the stage's own promote bar. The combined promote bar doubles because
 * the holdout reads a second frozen report per fixture, but a loss of that size
 * is not twice as convincing: doubling the reject bound with it would let a
 * candidate lose four matches on the widened grid and still read
 * `INCONCLUSIVE`. Both stages therefore reject at the same size, which is the
 * minus two ADR 0083 rejected at on the three-fixture grid.
 */
function rejectBound(opportunities, draws) {
  return -Math.max(
    REJECT_KNOWN_NET_FLOOR,
    Math.round(KNOWN_NET_RATE * opportunities.scorable_opportunities * draws),
  );
}

/** Every threshold this campaign judges on, derived from its own panel. */
export function experimentPolicy({ fixtures, draws = 1 }) {
  const opportunities = experimentOpportunities(fixtures, draws);
  const halfThePanel = Math.ceil(opportunities.prs / 2);
  // A grid that froze no P1 defect at all has no P1 evidence to judge, so the
  // P1 bars drop to zero and are named inert. Leaving them at their floors
  // would plan a campaign whose finalist gate no candidate could ever pass.
  const p1Live = opportunities.p1_opportunities > 0;
  const shared = {
    permutation_alpha: PERMUTATION_ALPHA,
    known_net_reject_max: rejectBound(opportunities, draws),
    p1_gates: p1Live ? "applicable" : "not applicable",
  };
  return {
    draws,
    opportunities,
    screen: {
      known_net_min: Math.max(
        SCREEN_KNOWN_NET_FLOOR,
        Math.round(
          KNOWN_NET_RATE * opportunities.scorable_opportunities * draws,
        ),
      ),
      // No net P1 loss. The screen never asks a candidate to gain P1 defects.
      p1_net_min: 0,
      nonnegative_prs_min: halfThePanel,
      ...shared,
    },
    combined: {
      known_net_min: Math.max(
        COMBINED_KNOWN_NET_FLOOR,
        Math.round(
          KNOWN_NET_RATE *
            opportunities.scorable_opportunities *
            draws *
            PAIRED_REPORTS_PER_FIXTURE,
        ),
      ),
      candidate_p1_min: p1Live
        ? Math.round(CANDIDATE_P1_RATIO * opportunities.p1_opportunities)
        : 0,
      p1_opportunities: opportunities.p1_opportunities,
      p1_net_min: p1Live
        ? Math.max(
            P1_NET_FLOOR,
            Math.round(P1_NET_RATE * opportunities.p1_opportunities),
          )
        : 0,
      gaining_prs_min: halfThePanel,
      nonnegative_prs_min: halfThePanel,
      wrong_claim_delta_max: WRONG_CLAIM_DELTA_MAX,
      ...shared,
    },
    claim_inflation: { ...CLAIM_INFLATION },
  };
}

/** The cells one planned stage owes, in total and per arm. */
export function stageCellCounts(stagePlan) {
  const lanes = stagePlan?.lanes ?? [];
  const perArm = {};
  let cells = 0;
  for (const lane of lanes) {
    for (const treatment of lane.sequence ?? []) {
      perArm[treatment] = (perArm[treatment] ?? 0) + 1;
      cells += 1;
    }
  }
  return { lanes: lanes.length, cells, per_arm: perArm };
}

/** xorshift128 over four words of the seed digest: same seed, same flips. */
function seededFlips(seed) {
  const bytes = createHash("sha256").update(String(seed)).digest();
  let [x, y, z, w] = [0, 4, 8, 12].map((offset) =>
    Math.max(1, bytes.readUInt32BE(offset)),
  );
  return () => {
    const t = (x ^ (x << 11)) >>> 0;
    [x, y, z] = [y, z, w];
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
}

function differenceValues(differences) {
  if (!Array.isArray(differences)) {
    throw new Error("paired differences must be an array");
  }
  return differences.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error("a paired difference must be a finite number");
    }
    // Every difference the decision produces is one match count minus another.
    // A fraction here means the caller pooled or averaged before pairing, which
    // breaks the exchangeability the flip test rests on.
    if (!Number.isSafeInteger(value)) {
      throw new Error("a paired difference must be an integer");
    }
    return value;
  });
}

function exactWidth(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > EXACT_FLIP_WIDTH_LIMIT
  ) {
    throw new Error(
      `exactMaxPairs must be an integer 1..${EXACT_FLIP_WIDTH_LIMIT}`,
    );
  }
  return value;
}

function exactFlipCounts(values, observed) {
  const total = 2 ** values.length;
  let ge = 0;
  let le = 0;
  for (let mask = 0; mask < total; mask += 1) {
    let sum = 0;
    for (const [index, value] of values.entries()) {
      sum += (mask >> index) & 1 ? -value : value;
    }
    if (sum >= observed) ge += 1;
    if (sum <= observed) le += 1;
  }
  return { ge, le, total };
}

function sampledFlipCounts(values, observed, seed, samples) {
  const next = seededFlips(seed);
  let ge = 0;
  let le = 0;
  for (let draw = 0; draw < samples; draw += 1) {
    let sum = 0;
    let bits = 0;
    let word = 0;
    for (const value of values) {
      if (bits === 0) {
        word = next();
        bits = 32;
      }
      sum += word & 1 ? -value : value;
      word >>>= 1;
      bits -= 1;
    }
    if (sum >= observed) ge += 1;
    if (sum <= observed) le += 1;
  }
  // The observed assignment is one of the flips, so it is counted on both
  // sides: the estimate stays conservative rather than reporting p = 0.
  return { ge: ge + 1, le: le + 1, total: samples + 1 };
}

/**
 * A one-sided exact sign-flip permutation test on the paired differences.
 *
 * Under the null the candidate and the incumbent are exchangeable within a
 * pair, so every difference could have carried either sign. `p_greater` is the
 * share of flip assignments whose sum reaches the observed sum, and `p_less`
 * the share that falls to it or below; a paired net that only a handful of the
 * assignments could produce is evidence, and one that most of them reach is
 * noise. Every flip is enumerated up to `exactMaxPairs`; above it the test
 * draws `samples` flips from a generator seeded by the plan digest, so the same
 * campaign always reads the same p-value.
 *
 * A zero difference flips to itself: it never moves the sum and it doubles both
 * tail counts, so it cancels out of every p-value. Only the non-zero
 * differences are enumerated, and only they decide whether the exact path fits.
 * Twenty-four tied lanes beside four informative ones therefore stay exact
 * rather than falling to sampling that has nothing extra to sample.
 * `informative_pairs` reports that width beside `n`.
 */
export function signFlipTest({
  differences,
  seed = "",
  exactMaxPairs = EXACT_FLIP_MAX_PAIRS,
  samples = PERMUTATION_SAMPLES,
}) {
  const values = differenceValues(differences);
  const width = exactWidth(exactMaxPairs);
  const informative = values.filter((value) => value !== 0);
  const net = values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0) {
    return {
      n: 0,
      informative_pairs: 0,
      net: 0,
      method: "none",
      p_greater: 1,
      p_less: 1,
    };
  }
  const exact = informative.length <= width;
  const counts = exact
    ? exactFlipCounts(informative, net)
    : sampledFlipCounts(
        informative,
        net,
        seed,
        positiveInteger(samples, "samples"),
      );
  return {
    n: values.length,
    informative_pairs: informative.length,
    net,
    method: exact ? "exact" : "sampled",
    ...(exact ? {} : { samples }),
    p_greater: counts.ge / counts.total,
    p_less: counts.le / counts.total,
  };
}
