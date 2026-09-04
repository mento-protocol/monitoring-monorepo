import assert from "node:assert/strict";
import test from "node:test";

import {
  experimentDraws,
  experimentPolicy,
  stageLanes,
  treatmentOrder,
} from "./review-eval-experiment-grid.mjs";

/** A grid twice the committed one, whose last fixture froze no P1 defect. */
function syntheticGrid({ p1 = true } = {}) {
  return Array.from({ length: 6 }, (_unused, index) => ({
    pr: 3000 + index,
    scorable_ids: Array.from({ length: 5 }, (_ignored, id) => index * 10 + id),
    p1_ids: p1 && index < 5 ? [index * 10, index * 10 + 1] : [],
    first_head: "a".repeat(40),
    base_sha: "b".repeat(40),
    truth_file: `truth-${index}.json`,
    truth_sha256: "c".repeat(64),
    finder_reports: [0, 1].map((report) => ({
      file: `report-${index}-${report}.md`,
      sha256: "d".repeat(64),
    })),
  }));
}

test("thresholds are derived from the grid and the draws", () => {
  const fixtures = syntheticGrid();
  // Thirty scorable ids, ten P1 ids, six PRs, two draws.
  const policy = experimentPolicy({ fixtures, draws: 2 });
  assert.deepEqual(policy.opportunities, {
    prs: 6,
    scorable_opportunities: 30,
    p1_opportunities: 40,
  });
  // 0.06 * 30 * 2 = 3.6, above the floor of two; the holdout reads a second
  // frozen report, so its bar doubles to 7.2.
  assert.equal(policy.screen.known_net_min, 4);
  assert.equal(policy.screen.nonnegative_prs_min, 3);
  assert.equal(policy.combined.known_net_min, 7);
  assert.equal(policy.combined.candidate_p1_min, 30);
  assert.equal(policy.combined.p1_net_min, 7);

  // A narrower grid at one draw falls back to the floors.
  const narrow = experimentPolicy({ fixtures: fixtures.slice(0, 3) });
  assert.equal(narrow.screen.known_net_min, 2);
  assert.equal(narrow.combined.known_net_min, 3);

  // A grid that froze no P1 defect at all runs with inert P1 bars; one such
  // fixture beside others only lowers them.
  const inert = experimentPolicy({ fixtures: syntheticGrid({ p1: false }) });
  assert.equal(inert.opportunities.p1_opportunities, 0);
  assert.equal(inert.combined.candidate_p1_min, 0);
  assert.equal(inert.combined.p1_net_min, 0);
  const mixed = experimentPolicy({ fixtures });
  assert.equal(mixed.opportunities.p1_opportunities, 20);
  assert.equal(mixed.combined.p1_net_min, 3);
});

test("every lane carries its draw in the id, the fields and the order", () => {
  const fixtures = syntheticGrid().slice(0, 3);
  const lanes = stageLanes({
    stage: "screen",
    fixtures,
    draws: 2,
    finderIdentity: "f".repeat(64),
  });
  assert.deepEqual(
    lanes.map((lane) => lane.lane_id),
    fixtures.flatMap((fixture) =>
      [0, 1].map((draw) => `screen-pr-${fixture.pr}-d${draw}`),
    ),
  );
  assert.deepEqual(
    lanes.map((lane) => lane.draw),
    [0, 1, 0, 1, 0, 1],
  );
  // Order alternates on the parity of the fixture and the draw together, so no
  // fixture keeps one arm first across its draws.
  assert.deepEqual(
    lanes.map((lane) => lane.paired_order),
    ["AB", "BA", "BA", "AB", "AB", "BA"],
  );
  assert.throws(
    () => treatmentOrder({ fixtureIndex: 0, drawIndex: -1 }),
    /drawIndex must be a non-negative integer/,
  );
  assert.equal(experimentDraws(), 1);
  for (const invalid of [0, 6, 1.5, "2"]) {
    assert.throws(() => experimentDraws(invalid), /draws must be an integer/);
  }
});
