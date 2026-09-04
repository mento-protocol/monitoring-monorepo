import assert from "node:assert/strict";
import test from "node:test";

import {
  experimentOpportunities,
  experimentPolicy,
  signFlipTest,
  stageCellCounts,
} from "./review-eval-experiment-stats.mjs";

const grid = [
  { pr: 1990, scorable_ids: [1, 2, 3, 4, 5, 6], p1_ids: [1, 2, 3] },
  { pr: 1995, scorable_ids: [1, 2, 3, 4, 5, 6], p1_ids: [1] },
  {
    pr: 1999,
    scorable_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    p1_ids: [1, 2],
  },
];

test("opportunities count the grid per draw and the P1 panel in full", () => {
  assert.deepEqual(experimentOpportunities(grid), {
    prs: 3,
    draws: 1,
    reports_per_fixture: 2,
    scorable_opportunities: 22,
    p1_opportunities: 12,
  });
  assert.equal(experimentOpportunities(grid, 3).p1_opportunities, 36);

  // A fixture that froze no P1 defect keeps its scorable opportunities and adds
  // no P1 one, so the P1 bars stay the rest of the panel's.
  assert.deepEqual(
    experimentOpportunities([
      ...grid,
      { pr: 2121, scorable_ids: [1, 2, 3, 4, 5], p1_ids: [] },
    ]),
    {
      prs: 4,
      draws: 1,
      reports_per_fixture: 2,
      scorable_opportunities: 27,
      p1_opportunities: 12,
    },
  );

  assert.throws(() => experimentOpportunities([]), /at least one fixture/);
  // A fixture with nothing to score is still a fixture with no lane to run.
  assert.throws(
    () => experimentOpportunities([{ pr: 1, scorable_ids: [], p1_ids: [] }]),
    /PR 1 has no scorable_ids/,
  );
  // No P1 list at all is a malformed fixture, not a fixture without P1s.
  assert.throws(
    () => experimentOpportunities([{ pr: 1, scorable_ids: [1] }]),
    /PR 1 p1_ids must be an array/,
  );
});

test("every threshold moves with the panel, and none below its floor", () => {
  const one = experimentPolicy({ fixtures: grid, draws: 1 });
  // 0.06 x 22 rounds to 1, so the screen floor of two holds.
  assert.equal(one.screen.known_net_min, 2);
  assert.equal(one.combined.known_net_min, 3);
  assert.equal(one.combined.candidate_p1_min, 9);
  assert.equal(one.combined.p1_net_min, 2);
  assert.equal(one.screen.nonnegative_prs_min, 2);
  assert.equal(one.combined.gaining_prs_min, 2);

  // The reject bound is derived from the screen rate and floor at BOTH stages,
  // so the combined stage rejects at minus two while it promotes at plus
  // three. Negating the combined promote bar would read minus three and stop
  // calling a loss the screen already rejects.
  assert.equal(one.screen.known_net_reject_max, -one.screen.known_net_min);
  assert.equal(one.combined.known_net_reject_max, -2);
  assert.notEqual(
    one.combined.known_net_reject_max,
    -one.combined.known_net_min,
  );

  // Two draws double the evidence, so the rates overtake both floors.
  const two = experimentPolicy({ fixtures: grid, draws: 2 });
  assert.equal(two.screen.known_net_min, 3);
  assert.equal(two.combined.known_net_min, 5);
  assert.equal(two.combined.candidate_p1_min, 18);
  assert.equal(two.combined.p1_net_min, 4);
  // The bound moves with the rate, not with the stage it is read at.
  assert.equal(two.screen.known_net_reject_max, -3);
  assert.equal(two.combined.known_net_reject_max, -3);

  // A wider grid raises the same bars; a narrower one lowers them.
  const wider = experimentPolicy({
    fixtures: [
      ...grid,
      { pr: 2001, scorable_ids: Array.from({ length: 20 }, (_x, i) => i) },
    ].map((fixture) => ({ ...fixture, p1_ids: fixture.p1_ids ?? [1, 2, 3] })),
    draws: 1,
  });
  assert.equal(wider.screen.known_net_min, 3);
  assert.equal(wider.combined.candidate_p1_min, 14);
  assert.equal(wider.screen.nonnegative_prs_min, 2);
  const narrow = experimentPolicy({
    fixtures: grid.map((fixture) => ({
      ...fixture,
      scorable_ids: fixture.scorable_ids.slice(0, 2),
      p1_ids: fixture.p1_ids.slice(0, 1),
    })),
    draws: 1,
  });
  assert.equal(narrow.screen.known_net_min, 2);
  assert.equal(narrow.combined.known_net_min, 3);
  assert.equal(narrow.combined.p1_net_min, 2);
  assert.throws(
    () => experimentPolicy({ fixtures: grid, draws: 1.5 }),
    /draws must be a positive integer/,
  );
});

test("a grid with no P1 defect at all zeroes its P1 bars and names them", () => {
  const noP1 = grid.map((fixture) => ({ ...fixture, p1_ids: [] }));
  const policy = experimentPolicy({ fixtures: noP1, draws: 1 });
  assert.equal(policy.opportunities.p1_opportunities, 0);
  // Left at their floors these would be a finalist gate no candidate could
  // pass: 0.75 of nothing is nothing, but the P1 net floor is two.
  assert.equal(policy.combined.candidate_p1_min, 0);
  assert.equal(policy.combined.p1_net_min, 0);
  assert.equal(policy.screen.p1_net_min, 0);
  assert.equal(policy.combined.p1_gates, "not applicable");
  assert.equal(policy.screen.p1_gates, "not applicable");
  // The known-defect bars are untouched: the panel still measures recall.
  assert.equal(policy.screen.known_net_min, 2);
  assert.equal(policy.combined.known_net_min, 3);

  // One P1 id anywhere on the grid puts both bars back at their floors.
  const oneP1 = [...noP1.slice(1), { ...grid[0], p1_ids: [1] }];
  const live = experimentPolicy({ fixtures: oneP1, draws: 1 });
  assert.equal(live.opportunities.p1_opportunities, 2);
  assert.equal(live.combined.candidate_p1_min, 2);
  assert.equal(live.combined.p1_net_min, 2);
  assert.equal(live.combined.p1_gates, "applicable");
});

test("a stage prices itself by cells and by arm", () => {
  assert.deepEqual(
    stageCellCounts({
      lanes: [
        { sequence: ["incumbent", "candidate"] },
        { sequence: ["candidate", "incumbent"] },
        { sequence: ["incumbent", "candidate"] },
      ],
    }),
    { lanes: 3, cells: 6, per_arm: { incumbent: 3, candidate: 3 } },
  );
  assert.deepEqual(stageCellCounts({ lanes: [] }), {
    lanes: 0,
    cells: 0,
    per_arm: {},
  });
});

test("the exact sign-flip test counts every assignment, both directions", () => {
  // Six pairs, each +1: only the observed assignment reaches the sum.
  const clean = signFlipTest({ differences: [1, 1, 1, 1, 1, 1] });
  assert.equal(clean.method, "exact");
  assert.equal(clean.n, 6);
  assert.equal(clean.net, 6);
  assert.equal(clean.p_greater, 1 / 64);
  assert.equal(clean.p_less, 1);

  // The same net spread as five gains and one loss: the sum of six is also
  // reached by the six assignments that flip one pair, so seven of the
  // sixty-four reach it and 0.109 does not clear a 0.10 bar.
  const noisy = signFlipTest({ differences: [1, 1, 1, 1, 1, -1] });
  assert.equal(noisy.net, 4);
  assert.equal(noisy.p_greater, 7 / 64);
  assert.equal(noisy.p_less, 63 / 64);

  // The mirror image: the loss is what the flips cannot explain away.
  const regression = signFlipTest({ differences: [-1, -1, -1, -1, -1, -1] });
  assert.equal(regression.p_less, 1 / 64);
  assert.equal(regression.p_greater, 1);

  // A zero pair is free on both sides, so it doubles both counts.
  const withZero = signFlipTest({ differences: [1, 1, 1, 1, 1, 0] });
  assert.equal(withZero.p_greater, 2 / 64);

  // No signal at all is never evidence in either direction.
  assert.deepEqual(signFlipTest({ differences: [0, 0, 0] }), {
    n: 3,
    informative_pairs: 0,
    net: 0,
    method: "exact",
    p_greater: 1,
    p_less: 1,
  });
  assert.deepEqual(signFlipTest({ differences: [] }), {
    n: 0,
    informative_pairs: 0,
    net: 0,
    method: "none",
    p_greater: 1,
    p_less: 1,
  });
  assert.throws(
    () => signFlipTest({ differences: [1, Number.NaN] }),
    /finite number/,
  );
});

test("ties never push a narrow panel off the exact path", () => {
  // Twenty-two lanes, five of which differ. `n` is over the twenty-pair exact
  // width, but the flip distribution is only five wide, so enumerating it is
  // both cheap and right. Counting the ties here would sample a distribution
  // that has nothing extra to sample.
  const differences = [3, -1, 2, 1, -2, ...Array.from({ length: 17 }, () => 0)];
  assert.equal(differences.length, 22);
  const result = signFlipTest({ differences, seed: "plan-digest" });
  assert.equal(result.n, 22);
  assert.equal(result.informative_pairs, 5);
  assert.equal(result.method, "exact");
  assert.equal(result.samples, undefined);

  // Brute force over every sign assignment of all twenty-two differences,
  // ties included, is the ground truth the exact path must reproduce.
  const brute = (values, observed) => {
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
    return { p_greater: ge / total, p_less: le / total };
  };
  const truth = brute(differences, result.net);
  assert.equal(result.net, 3);
  assert.equal(result.p_greater, truth.p_greater);
  assert.equal(result.p_less, truth.p_less);

  // The other direction: twenty-one informative differences still sample.
  const wide = signFlipTest({
    differences: Array.from({ length: 21 }, () => 1),
    seed: "plan-digest",
    samples: 200,
  });
  assert.equal(wide.method, "sampled");
});

test("the test counts the pairs that can move the sum, and rejects the rest", () => {
  // Six pairs, but two of them tie: the flip distribution is four coin tosses
  // wide, so the caller must gate on `informative_pairs`, not on `n`.
  const tied = signFlipTest({ differences: [1, 1, 1, 1, 0, 0] });
  assert.equal(tied.n, 6);
  assert.equal(tied.informative_pairs, 4);
  assert.equal(tied.p_greater, 4 / 64);
  const clean = signFlipTest({ differences: [1, 1, 1, 1, 1, 1] });
  assert.equal(clean.informative_pairs, 6);

  // A fractional difference means the caller pooled before pairing.
  assert.throws(
    () => signFlipTest({ differences: [1, 0.5] }),
    /paired difference must be an integer/,
  );
  for (const exactMaxPairs of [0, 26, 4.5, "6"]) {
    assert.throws(
      () => signFlipTest({ differences: [1, 1], exactMaxPairs }),
      /exactMaxPairs must be an integer 1\.\.25/,
    );
  }
  assert.equal(
    signFlipTest({ differences: [1, 1], exactMaxPairs: 25 }).method,
    "exact",
  );
});

test("above the exact width the flips are seeded and reproducible", () => {
  const differences = Array.from({ length: 21 }, () => 1);
  const options = { differences, seed: "plan-digest", samples: 200 };
  const first = signFlipTest(options);
  const second = signFlipTest(options);
  assert.equal(first.method, "sampled");
  assert.equal(first.samples, 200);
  assert.deepEqual(first, second);
  // No sampled flip reaches 21 of 21, so only the observed assignment does.
  assert.equal(first.p_greater, 1 / 201);
  assert.equal(first.p_less, 1);

  // A different seed draws different flips, and a mixed vector shows it.
  const mixed = differences.map((value, index) => (index % 3 ? value : -value));
  const one = signFlipTest({ differences: mixed, seed: "seed-one" });
  const other = signFlipTest({ differences: mixed, seed: "seed-two" });
  assert.equal(one.method, "sampled");
  assert.equal(one.p_greater > 0, true);
  assert.equal(
    signFlipTest({ differences: mixed, seed: "seed-one" }).p_greater,
    one.p_greater,
  );
  assert.equal(Number.isFinite(other.p_greater), true);

  // The exact width is a parameter, so the two paths can be compared.
  const narrow = signFlipTest({
    differences: [1, 1, 1, 1, 1, 1],
    seed: "plan-digest",
    exactMaxPairs: 4,
    samples: 4000,
  });
  assert.equal(narrow.method, "sampled");
  assert.equal(Math.abs(narrow.p_greater - 1 / 64) < 0.02, true);
});

// The shape of the widened grid: six fixtures, 43 scorable and 11 P1 ids. The
// counts are the panel's; the per-PR split only has to add up.
const widenedGrid = [
  { pr: 1990, scorable: 6, p1: 3 },
  { pr: 1995, scorable: 6, p1: 1 },
  { pr: 1999, scorable: 10, p1: 2 },
  { pr: 2035, scorable: 7, p1: 2 },
  { pr: 2039, scorable: 7, p1: 2 },
  { pr: 2121, scorable: 7, p1: 1 },
].map(({ pr, scorable, p1 }) => ({
  pr,
  scorable_ids: Array.from(
    { length: scorable },
    (_x, index) => pr * 100 + index,
  ),
  p1_ids: Array.from({ length: p1 }, (_x, index) => pr * 100 + index),
}));

test("the widened grid prices every bar, and a rate change moves them", () => {
  assert.deepEqual(experimentOpportunities(widenedGrid, 1), {
    prs: 6,
    draws: 1,
    reports_per_fixture: 2,
    scorable_opportunities: 43,
    p1_opportunities: 22,
  });

  // 0.06 x 43 x draws for the screen, twice that for the combined stage, so a
  // change to the rate lands here before it reaches a campaign.
  const expected = [
    {
      draws: 1,
      screenNet: 3,
      combinedNet: 5,
      p1Opportunities: 22,
      candidateP1: 17,
      p1Net: 4,
    },
    {
      draws: 2,
      screenNet: 5,
      combinedNet: 10,
      p1Opportunities: 44,
      candidateP1: 33,
      p1Net: 7,
    },
    {
      draws: 3,
      screenNet: 8,
      combinedNet: 15,
      p1Opportunities: 66,
      candidateP1: 50,
      p1Net: 11,
    },
  ];
  for (const row of expected) {
    const policy = experimentPolicy({
      fixtures: widenedGrid,
      draws: row.draws,
    });
    assert.equal(policy.screen.known_net_min, row.screenNet);
    assert.equal(policy.combined.known_net_min, row.combinedNet);
    assert.equal(policy.opportunities.p1_opportunities, row.p1Opportunities);
    assert.equal(policy.combined.p1_opportunities, row.p1Opportunities);
    assert.equal(policy.combined.candidate_p1_min, row.candidateP1);
    assert.equal(policy.combined.p1_net_min, row.p1Net);
    // Half the panel, whatever the draw count.
    assert.equal(policy.screen.nonnegative_prs_min, 3);
    assert.equal(policy.combined.gaining_prs_min, 3);
    assert.equal(policy.combined.nonnegative_prs_min, 3);
  }
});
