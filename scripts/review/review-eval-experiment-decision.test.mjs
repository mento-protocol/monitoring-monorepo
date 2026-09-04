import assert from "node:assert/strict";
import test from "node:test";

import {
  claimInflationRequiresNovelty,
  evaluateExperimentDecision,
} from "./review-eval-experiment-decision.mjs";
import { experimentPolicy } from "./review-eval-experiment-stats.mjs";

const candidateId = "candidate-1";
const fixtures = [
  {
    pr: 1,
    scorable_ids: [101, 102, 103, 104, 105, 106],
    p1_ids: [101, 102, 103],
  },
  {
    pr: 2,
    scorable_ids: [201, 202, 203, 204, 205, 206],
    p1_ids: [201],
  },
  {
    pr: 3,
    scorable_ids: [301, 302, 303, 304, 305, 306, 307, 308],
    p1_ids: [301, 302],
  },
];

function plan() {
  const stage = (name) => ({
    stage: name,
    enabled: true,
    draws: 1,
    lanes: fixtures.map((fixture, index) => ({
      lane_id: `${candidateId}-${name}-pr-${fixture.pr}-d0`,
      pr: fixture.pr,
      draw: 0,
      fixture,
      sequence:
        index % 2 === 0
          ? ["incumbent", "candidate"]
          : ["candidate", "incumbent"],
    })),
  });
  return {
    campaign_id: "campaign-1",
    plan_digest: "d".repeat(64),
    candidate: { id: candidateId },
    draws: 1,
    // 20 scorable and 6 P1 ids over three PRs: screen net 2, combined net 3,
    // 9 of 12 candidate P1, P1 net 2, two PRs each way.
    policy: experimentPolicy({ fixtures, draws: 1 }),
    stages: {
      screen: stage("screen"),
      holdout: stage("holdout"),
      "live-paired": stage("live-paired"),
    },
  };
}

const fixtureByPr = new Map(fixtures.map((fixture) => [fixture.pr, fixture]));

function armRecord(
  campaign,
  stage,
  pr,
  treatment,
  { known, p1, claims = known, wrongClaims },
) {
  const fixture = fixtureByPr.get(pr);
  const p1Ids = fixture.p1_ids.slice(0, p1);
  const ordinary = fixture.scorable_ids.filter(
    (id) => !fixture.p1_ids.includes(id),
  );
  const matchedIds = [...p1Ids, ...ordinary.slice(0, known - p1)];
  assert.equal(matchedIds.length, known);
  const lane = campaign.stages[stage].lanes.find((item) => item.pr === pr);
  return {
    ok: true,
    campaign_id: campaign.campaign_id,
    candidate_id: campaign.candidate.id,
    stage,
    cell_id: `${lane.lane_id}-${treatment}`,
    pr,
    treatment,
    claims_count: Math.max(1, claims),
    matched_ids: matchedIds,
    leak: { suspected: false },
    empty: false,
    ...(wrongClaims === undefined ? {} : { wrong_claims: wrongClaims }),
  };
}

function records(campaign, stage, specs, { classify = false } = {}) {
  return specs.flatMap(({ pr, incumbent, candidate }) =>
    [
      ["incumbent", incumbent],
      ["candidate", candidate],
    ].map(([treatment, values]) =>
      armRecord(campaign, stage, pr, treatment, {
        ...values,
        ...(classify ? { wrongClaims: values.wrongClaims ?? 0 } : {}),
      }),
    ),
  );
}

const screenSpecs = [
  {
    pr: 1,
    incumbent: { known: 1, p1: 0 },
    candidate: { known: 4, p1: 3 },
  },
  {
    pr: 2,
    incumbent: { known: 2, p1: 1 },
    candidate: { known: 1, p1: 1 },
  },
  {
    pr: 3,
    incumbent: { known: 2, p1: 1 },
    candidate: { known: 2, p1: 1 },
  },
];

// A finalist panel: six paired lanes, five of them gaining, so the combined
// decision has enough pairs for the sign-flip test to run and to pass it.
const finalistScreenSpecs = [
  {
    pr: 1,
    incumbent: { known: 2, p1: 1 },
    candidate: { known: 3, p1: 3 },
  },
  {
    pr: 2,
    incumbent: { known: 2, p1: 0 },
    candidate: { known: 3, p1: 1 },
  },
  {
    pr: 3,
    incumbent: { known: 3, p1: 1 },
    candidate: { known: 3, p1: 1 },
  },
];

const holdoutSpecs = [
  {
    pr: 1,
    incumbent: { known: 2, p1: 2 },
    candidate: { known: 3, p1: 2 },
  },
  {
    pr: 2,
    incumbent: { known: 1, p1: 0 },
    candidate: { known: 2, p1: 1 },
  },
  {
    pr: 3,
    incumbent: { known: 3, p1: 2 },
    candidate: { known: 4, p1: 2, wrongClaims: 1 },
  },
];

function decide(campaign, stage, recordsByStage) {
  return evaluateExperimentDecision({
    plan: campaign,
    candidateId,
    stage,
    recordsByStage,
  });
}

test("a three-PR single-draw panel clears every bar but the alpha", () => {
  const campaign = plan();
  const screen = records(campaign, "screen", screenSpecs);
  const passed = decide(campaign, "screen", { screen });
  assert.deepEqual(passed.metrics.known, {
    incumbent: 5,
    candidate: 7,
    net: 2,
  });
  assert.equal(passed.metrics.p1.net, 3);
  assert.equal(passed.metrics.nonnegative_prs, 2);
  assert.equal(passed.metrics.p1_gates, "applicable");
  // Every recall bar is met and the panel still cannot promote: three lanes of
  // which two differ give a four-assignment flip distribution, half of which
  // reach the observed sum. The p-value is in the reason, so the operator
  // reads why rather than only that.
  assert.equal(passed.metrics.permutation.pairs, 3);
  assert.equal(passed.metrics.permutation.informative_pairs, 2);
  assert.equal(passed.metrics.permutation.p_greater, 0.5);
  assert.equal(passed.status, "INCONCLUSIVE");
  assert.deepEqual(passed.reasons, [
    "paired sign-flip significance missed: p 0.5000 vs alpha 0.1 " +
      "(informative pairs 2)",
  ]);
  assert.deepEqual(passed.novelty, {
    required: false,
    deferred: true,
    reason: "recall thresholds did not pass",
  });

  const short = structuredClone(screen);
  short
    .find((record) => record.pr === 3 && record.treatment === "candidate")
    .matched_ids.pop();
  assert.equal(
    decide(campaign, "screen", { screen: short }).status,
    "INCONCLUSIVE",
  );

  const narrow = records(campaign, "screen", [
    {
      pr: 1,
      incumbent: { known: 1, p1: 0 },
      candidate: { known: 5, p1: 3 },
    },
    {
      pr: 2,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 3,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
  ]);
  const narrowDecision = decide(campaign, "screen", { screen: narrow });
  assert.equal(narrowDecision.metrics.known.net, 2);
  assert.equal(narrowDecision.metrics.nonnegative_prs, 1);
  assert.equal(narrowDecision.status, "INCONCLUSIVE");
});

test("clear known and P1 regressions reject", () => {
  const campaign = plan();
  const knownRegression = records(campaign, "screen", [
    {
      pr: 1,
      incumbent: { known: 1, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 2,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 3,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
  ]);
  const known = decide(campaign, "screen", { screen: knownRegression });
  assert.equal(known.metrics.known.net, -2);
  assert.equal(known.status, "REJECT");
  assert.deepEqual(known.reasons, ["known net reached the reject bound"]);

  const p1Regression = records(campaign, "screen", [
    {
      pr: 1,
      incumbent: { known: 1, p1: 1 },
      candidate: { known: 4, p1: 3 },
    },
    {
      pr: 2,
      incumbent: { known: 2, p1: 1 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 3,
      incumbent: { known: 2, p1: 2 },
      candidate: { known: 2, p1: 0 },
    },
  ]);
  const p1 = decide(campaign, "screen", { screen: p1Regression });
  assert.equal(p1.metrics.known.net, 2);
  assert.equal(p1.metrics.p1.net, -1);
  assert.equal(p1.status, "REJECT");
});

test("the combined stage rejects at the screen's bound, not at its own bar", () => {
  const campaign = plan();
  // The promote bar doubles at the holdout; the reject bound does not. A
  // combined net of minus two is the loss ADR 0083 rejected at, and negating
  // the combined promote bar would have read minus three and let it stand.
  assert.equal(campaign.policy.combined.known_net_min, 3);
  assert.equal(campaign.policy.combined.known_net_reject_max, -2);
  assert.equal(campaign.policy.screen.known_net_reject_max, -2);

  const losing = (drop) => [
    {
      pr: 1,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: drop ? 1 : 2, p1: 0 },
    },
    { pr: 2, incumbent: { known: 2, p1: 0 }, candidate: { known: 2, p1: 0 } },
    { pr: 3, incumbent: { known: 2, p1: 0 }, candidate: { known: 2, p1: 0 } },
  ];
  const rejected = decide(campaign, "holdout", {
    screen: records(campaign, "screen", losing(true)),
    holdout: records(campaign, "holdout", losing(true)),
  });
  assert.equal(rejected.metrics.known.net, -2);
  assert.equal(rejected.metrics.p1.net, 0);
  assert.deepEqual(rejected.reasons, ["known net reached the reject bound"]);
  assert.equal(rejected.status, "REJECT");

  // One match back and the same panel is only a miss, so the bound is a
  // boundary rather than a blanket.
  const milder = decide(campaign, "holdout", {
    screen: records(campaign, "screen", losing(true)),
    holdout: records(campaign, "holdout", losing(false)),
  });
  assert.equal(milder.metrics.known.net, -1);
  assert.equal(milder.status, "INCONCLUSIVE");
});

test("exact planned records fail closed without penalizing the incumbent", () => {
  const campaign = plan();
  const complete = records(campaign, "screen", screenSpecs);

  const missing = structuredClone(complete);
  missing.pop();
  assert.equal(
    decide(campaign, "screen", { screen: missing }).status,
    "INCONCLUSIVE",
  );

  const duplicate = [...complete, structuredClone(complete[0])];
  assert.equal(
    decide(campaign, "screen", { screen: duplicate }).status,
    "INCONCLUSIVE",
  );

  const malformed = structuredClone(complete);
  malformed[0].campaign_id = "other-campaign";
  assert.equal(
    decide(campaign, "screen", { screen: malformed }).status,
    "INCONCLUSIVE",
  );

  const missingCellId = structuredClone(complete);
  delete missingCellId[0].cell_id;
  assert.equal(
    decide(campaign, "screen", { screen: missingCellId }).status,
    "INCONCLUSIVE",
  );

  for (const mutate of [
    (record) => delete record.empty,
    (record) => delete record.leak.suspected,
    (record) => (record.cellId = "legacy-cell-id"),
  ]) {
    const invalidGateEvidence = structuredClone(complete);
    mutate(invalidGateEvidence[0]);
    assert.equal(
      decide(campaign, "screen", { screen: invalidGateEvidence }).status,
      "INCONCLUSIVE",
    );
  }

  const duplicateMatch = structuredClone(complete);
  duplicateMatch[0].matched_ids.push(duplicateMatch[0].matched_ids[0]);
  assert.equal(
    decide(campaign, "screen", { screen: duplicateMatch }).status,
    "INCONCLUSIVE",
  );

  const badWrongCount = structuredClone(complete);
  badWrongCount[0].wrong_claims = badWrongCount[0].claims_count + 1;
  assert.equal(
    decide(campaign, "screen", { screen: badWrongCount }).status,
    "INCONCLUSIVE",
  );

  const incumbentEmpty = structuredClone(complete);
  const incumbent = incumbentEmpty.find(
    (record) => record.treatment === "incumbent",
  );
  incumbent.empty = true;
  incumbent.claims_count = 0;
  incumbent.matched_ids = [];
  assert.equal(
    decide(campaign, "screen", { screen: incumbentEmpty }).status,
    "INCONCLUSIVE",
  );
});

test("candidate empty output and hard leaks reject", () => {
  const campaign = plan();
  const empty = records(campaign, "screen", screenSpecs);
  const candidate = empty.find((record) => record.treatment === "candidate");
  candidate.empty = true;
  candidate.claims_count = 0;
  candidate.matched_ids = [];
  assert.equal(decide(campaign, "screen", { screen: empty }).status, "REJECT");

  const leaked = records(campaign, "screen", screenSpecs);
  leaked.find((record) => record.treatment === "candidate").leak.suspected =
    true;
  assert.equal(decide(campaign, "screen", { screen: leaked }).status, "REJECT");
});

/** A screen every recall bar passes, wide enough to clear the alpha. */
function significantScreen(campaign) {
  return drawRecords(campaign, "screen", [
    { pr: 1, incumbent: { known: 2, p1: 1 }, candidate: { known: 3, p1: 2 } },
    { pr: 2, incumbent: { known: 2, p1: 0 }, candidate: { known: 3, p1: 1 } },
    { pr: 3, incumbent: { known: 2, p1: 1 }, candidate: { known: 3, p1: 1 } },
  ]);
}

test("screen defers novelty only after known matching passes", () => {
  const campaign = multiDrawPlan(2);
  const inflated = significantScreen(campaign).map((record) =>
    record.treatment === "candidate"
      ? { ...record, claims_count: record.claims_count + 4 }
      : record,
  );
  const screenOf = (screen) =>
    evaluateExperimentDecision({
      plan: campaign,
      candidateId,
      stage: "screen",
      recordsByStage: { screen },
    });
  const deferred = screenOf(inflated);
  // The novelty question is only reached because this panel passes recall:
  // six informative pairs at 1/64.
  assert.equal(deferred.metrics.permutation.informative_pairs, 6);
  assert.equal(deferred.metrics.permutation.p_greater, 1 / 64);
  assert.equal(deferred.status, "INCONCLUSIVE");
  assert.equal(deferred.novelty.required, true);
  assert.equal(deferred.novelty.deferred, true);

  const classified = inflated.map((record) => ({ ...record, wrong_claims: 0 }));
  const passed = screenOf(classified);
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.novelty.required, true);
  assert.equal(passed.novelty.deferred, false);

  const wrong = classified.map((record, index) =>
    index === 1 ? { ...record, wrong_claims: 2 } : record,
  );
  assert.equal(wrong[1].treatment, "candidate");
  assert.equal(screenOf(wrong).status, "REJECT");
});

test("holdout finalists require novelty and pass the combined 9-of-12 gate", () => {
  const campaign = plan();
  const unclassified = {
    screen: records(campaign, "screen", finalistScreenSpecs),
    holdout: records(campaign, "holdout", holdoutSpecs),
  };
  const deferred = decide(campaign, "holdout", unclassified);
  assert.equal(deferred.status, "INCONCLUSIVE");
  assert.deepEqual(deferred.novelty, {
    required: true,
    deferred: true,
    reason: "combined recall thresholds passed",
  });

  const classified = {
    screen: records(campaign, "screen", finalistScreenSpecs, {
      classify: true,
    }),
    holdout: records(campaign, "holdout", holdoutSpecs, { classify: true }),
  };
  const passed = decide(campaign, "holdout", classified);
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.metrics.known.net, 5);
  assert.equal(passed.metrics.p1.candidate, 10);
  assert.equal(passed.metrics.p1.net, 4);
  assert.equal(passed.metrics.gaining_prs, 3);
  assert.equal(passed.metrics.wrong_claims.net, 1);
  // Six pairs, but one of them ties, so only five differences can move the
  // sum. A tie is free on both sides of the flip distribution, so the five
  // that differ set the p-value on their own and it clears the alpha.
  assert.deepEqual(
    passed.metrics.pairs.map((pair) => pair.d),
    [1, 1, 1, 1, 1, 0],
  );
  assert.equal(passed.metrics.permutation.pairs, 6);
  assert.equal(passed.metrics.permutation.informative_pairs, 5);
  assert.equal(passed.metrics.permutation.p_greater, 1 / 32);

  const knownShort = structuredClone(classified);
  for (const pr of [1, 2, 3]) {
    knownShort.holdout
      .find((record) => record.pr === pr && record.treatment === "candidate")
      .matched_ids.pop();
  }
  const shortDecision = decide(campaign, "holdout", knownShort);
  assert.equal(shortDecision.metrics.known.net, 2);
  assert.equal(shortDecision.status, "INCONCLUSIVE");

  const p1Floor = structuredClone(classified);
  const floored = p1Floor.screen.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  );
  floored.matched_ids = [101, 105, 106];
  const floorDecision = decide(campaign, "holdout", p1Floor);
  assert.equal(floorDecision.metrics.p1.candidate, 8);
  assert.equal(floorDecision.status, "INCONCLUSIVE");

  const p1Net = structuredClone(classified);
  for (const [stage, pr, replacement] of [
    ["screen", 1, 102],
    ["holdout", 2, 201],
    ["screen", 3, 302],
  ]) {
    const record = p1Net[stage].find(
      (item) => item.pr === pr && item.treatment === "incumbent",
    );
    const fixture = fixtureByPr.get(pr);
    const ordinary = record.matched_ids.findIndex(
      (id) => !fixture.p1_ids.includes(id),
    );
    record.matched_ids[ordinary] = replacement;
  }
  const p1NetDecision = decide(campaign, "holdout", p1Net);
  assert.equal(p1NetDecision.metrics.p1.candidate, 10);
  assert.equal(p1NetDecision.metrics.p1.net, 1);
  assert.equal(p1NetDecision.status, "INCONCLUSIVE");

  // One PR carries the whole net: the gaining-PR bar names it.
  const narrowGains = structuredClone(classified);
  for (const [stage, pr] of [
    ["screen", 2],
    ["holdout", 2],
    ["holdout", 3],
  ]) {
    const record = narrowGains[stage].find(
      (item) => item.pr === pr && item.treatment === "candidate",
    );
    record.matched_ids.pop();
    record.claims_count -= 1;
  }
  const lifted = narrowGains.screen.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  );
  lifted.matched_ids.push(104, 105);
  lifted.claims_count += 2;
  const gainsDecision = decide(campaign, "holdout", narrowGains);
  assert.equal(gainsDecision.metrics.known.net, 4);
  assert.equal(gainsDecision.metrics.gaining_prs, 1);
  assert.equal(gainsDecision.status, "INCONCLUSIVE");
  assert.equal(gainsDecision.reasons.includes("gaining PRs missed"), true);

  classified.screen.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  ).wrong_claims = 1;
  assert.equal(decide(campaign, "holdout", classified).status, "REJECT");
});

test("claim inflation requires both the absolute and ratio thresholds", () => {
  const policy = plan().policy;
  assert.equal(
    claimInflationRequiresNovelty({
      incumbentClaims: 10,
      candidateClaims: 13,
      policy,
    }).required,
    true,
  );
  assert.equal(
    claimInflationRequiresNovelty({
      incumbentClaims: 20,
      candidateClaims: 23,
      policy,
    }).required,
    false,
  );
  assert.throws(
    () =>
      claimInflationRequiresNovelty({
        incumbentClaims: -1,
        candidateClaims: 1,
        policy,
      }),
    /non-negative integers/,
  );
});

/** The same panel drawn `draws` times: one lane per fixture per draw. */
function multiDrawPlan(draws) {
  const stage = (name) => ({
    stage: name,
    enabled: true,
    draws,
    lanes: fixtures.flatMap((fixture, index) =>
      Array.from({ length: draws }, (_unused, draw) => ({
        lane_id: `${candidateId}-${name}-pr-${fixture.pr}-d${draw}`,
        pr: fixture.pr,
        draw,
        fixture,
        sequence:
          (index + draw) % 2 === 0
            ? ["incumbent", "candidate"]
            : ["candidate", "incumbent"],
      })),
    ),
  });
  return {
    campaign_id: "campaign-draws",
    plan_digest: "e".repeat(64),
    candidate: { id: candidateId },
    draws,
    policy: experimentPolicy({ fixtures, draws }),
    stages: {
      screen: stage("screen"),
      holdout: stage("holdout"),
      "live-paired": stage("live-paired"),
    },
  };
}

/** One arm record per planned lane, from a per-PR spec repeated every draw. */
function drawRecords(campaign, stage, specs, { classify = false } = {}) {
  const byPr = new Map(specs.map((spec) => [spec.pr, spec]));
  return campaign.stages[stage].lanes.flatMap((lane) => {
    const spec = byPr.get(lane.pr);
    return ["incumbent", "candidate"].map((treatment) => {
      const values = spec[treatment];
      const fixture = fixtureByPr.get(lane.pr);
      const p1Ids = fixture.p1_ids.slice(0, values.p1);
      const ordinary = fixture.scorable_ids.filter(
        (id) => !fixture.p1_ids.includes(id),
      );
      const matchedIds = [
        ...p1Ids,
        ...ordinary.slice(0, values.known - values.p1),
      ];
      assert.equal(matchedIds.length, values.known);
      return {
        ok: true,
        campaign_id: campaign.campaign_id,
        candidate_id: campaign.candidate.id,
        stage,
        cell_id: `${lane.lane_id}-${treatment}`,
        pr: lane.pr,
        treatment,
        claims_count: 12,
        matched_ids: matchedIds,
        leak: { suspected: false },
        empty: false,
        ...(classify ? { wrong_claims: 0 } : {}),
      };
    });
  });
}

const twoDrawSpecs = [
  {
    pr: 1,
    incumbent: { known: 3, p1: 2 },
    candidate: { known: 4, p1: 3 },
  },
  {
    pr: 2,
    incumbent: { known: 2, p1: 1 },
    candidate: { known: 3, p1: 1 },
  },
  {
    pr: 3,
    incumbent: { known: 3, p1: 1 },
    candidate: { known: 3, p1: 1 },
  },
];

test("a two-draw holdout pairs every draw and reads the wider bars", () => {
  const campaign = multiDrawPlan(2);
  // 20 scorable ids over three PRs at two draws: combined net 5, 24 P1
  // opportunities, 18 of them matched, P1 net 4.
  assert.equal(campaign.policy.combined.known_net_min, 5);
  assert.equal(campaign.policy.combined.candidate_p1_min, 18);
  assert.equal(campaign.policy.combined.p1_net_min, 4);
  assert.equal(campaign.policy.opportunities.p1_opportunities, 24);

  const classified = {
    screen: drawRecords(campaign, "screen", twoDrawSpecs, { classify: true }),
    holdout: drawRecords(campaign, "holdout", twoDrawSpecs, { classify: true }),
  };
  const passed = evaluateExperimentDecision({
    plan: campaign,
    candidateId,
    stage: "holdout",
    recordsByStage: classified,
  });
  // Twelve pairs: three PRs, two draws, two stages. Each draw is its own pair,
  // never pooled into its PR.
  assert.equal(passed.metrics.pairs.length, 12);
  assert.deepEqual(
    passed.metrics.pairs
      .filter((pair) => pair.stage === "holdout" && pair.pr === 1)
      .map((pair) => pair.draw),
    [0, 1],
  );
  assert.equal(passed.metrics.known.net, 8);
  assert.equal(passed.metrics.p1.candidate, 20);
  assert.equal(passed.metrics.p1.net, 4);
  assert.equal(passed.metrics.gaining_prs, 2);
  assert.equal(passed.metrics.nonnegative_prs, 3);
  // Eight of the twelve differences are non-zero, so the flip test binds, and
  // only the sixteen assignments that keep every gain reach the observed sum.
  assert.equal(passed.metrics.permutation.pairs, 12);
  assert.equal(passed.metrics.permutation.informative_pairs, 8);
  assert.equal(passed.metrics.permutation.p_greater, 1 / 256);
  assert.equal(passed.metrics.thresholds.known_net_min, 5);
  assert.equal(passed.status, "PROMISING");

  // One match less on every PR 1 candidate lane: a net of four misses the
  // five the two-draw panel asks for.
  const short = structuredClone(classified);
  for (const stage of ["screen", "holdout"]) {
    for (const record of short[stage]) {
      if (record.pr === 1 && record.treatment === "candidate") {
        record.matched_ids.pop();
      }
    }
  }
  const shortDecision = evaluateExperimentDecision({
    plan: campaign,
    candidateId,
    stage: "holdout",
    recordsByStage: short,
  });
  assert.equal(shortDecision.metrics.known.net, 4);
  assert.equal(shortDecision.status, "INCONCLUSIVE");
  assert.equal(shortDecision.reasons.includes("known net missed"), true);
});

test("the flip test reads the informative pairs, at every width", () => {
  const campaign = multiDrawPlan(2);
  const screenOf = (screen) =>
    evaluateExperimentDecision({
      plan: campaign,
      candidateId,
      stage: "screen",
      recordsByStage: { screen },
    });
  // Six lanes per stage, so a screen alone gives six pairs. PR 3 ties on both
  // draws, leaving four differences that can move the sum. Four same-direction
  // pairs floor at 1/16, the narrowest panel that can promote.
  const tiedDecision = screenOf(drawRecords(campaign, "screen", twoDrawSpecs));
  assert.equal(tiedDecision.metrics.permutation.pairs, 6);
  assert.equal(tiedDecision.metrics.permutation.informative_pairs, 4);
  assert.equal(tiedDecision.metrics.permutation.p_greater, 1 / 16);
  assert.equal(tiedDecision.status, "PROMISING");

  // The same six lanes with PR 3 gaining too: six differences, a quarter of
  // the p-value.
  const informativeDecision = screenOf(
    drawRecords(
      campaign,
      "screen",
      twoDrawSpecs.map((spec) =>
        spec.pr === 3 ? { ...spec, candidate: { known: 4, p1: 1 } } : spec,
      ),
    ),
  );
  assert.equal(informativeDecision.metrics.permutation.informative_pairs, 6);
  assert.equal(informativeDecision.metrics.permutation.p_greater, 1 / 64);
  assert.equal(informativeDecision.status, "PROMISING");

  // `live-paired` reads the screen thresholds on its own pairs.
  assert.equal(
    evaluateExperimentDecision({
      plan: campaign,
      candidateId,
      stage: "live-paired",
      recordsByStage: {
        "live-paired": drawRecords(campaign, "live-paired", twoDrawSpecs),
      },
    }).status,
    "PROMISING",
  );

  // Three same-direction pairs floor at 1/8. Every other bar passes and the
  // panel still cannot promote, which is why the three-PR single-draw grid is
  // retired as a promotion panel.
  const single = plan();
  const evenGain = [1, 2, 3].map((pr) => ({
    pr,
    incumbent: { known: 1, p1: 0 },
    candidate: { known: 2, p1: 0 },
  }));
  const threeWide = decide(single, "screen", {
    screen: records(single, "screen", evenGain),
  });
  assert.equal(threeWide.metrics.known.net, 3);
  assert.equal(threeWide.metrics.nonnegative_prs, 3);
  assert.equal(threeWide.metrics.permutation.informative_pairs, 3);
  assert.equal(threeWide.metrics.permutation.p_greater, 1 / 8);
  assert.equal(threeWide.status, "INCONCLUSIVE");
  assert.deepEqual(threeWide.reasons, [
    "paired sign-flip significance missed: p 0.1250 vs alpha 0.1 " +
      "(informative pairs 3)",
  ]);

  // A significant paired loss is a rejection, and it names its own p-value.
  const losing = screenOf(
    drawRecords(
      campaign,
      "screen",
      twoDrawSpecs.map((spec) => ({
        pr: spec.pr,
        incumbent: { known: 3, p1: 1 },
        candidate: { known: 2, p1: 1 },
      })),
    ),
  );
  assert.equal(losing.metrics.permutation.informative_pairs, 6);
  assert.equal(losing.metrics.permutation.p_less, 1 / 64);
  assert.equal(losing.status, "REJECT");
  assert.deepEqual(losing.reasons, [
    "known net reached the reject bound",
    "paired regression is significant: p 0.0156 vs alpha 0.1 " +
      "(informative pairs 6)",
  ]);
});
