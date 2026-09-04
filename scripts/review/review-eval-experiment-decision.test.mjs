import assert from "node:assert/strict";
import test from "node:test";

import {
  claimInflationRequiresNovelty,
  evaluateExperimentDecision,
  signFlipPValue,
} from "./review-eval-experiment-decision.mjs";
import { experimentPolicy } from "./review-eval-experiment-grid.mjs";

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
    lanes: fixtures.map((fixture, index) => ({
      lane_id: `${candidateId}-${name}-pr-${fixture.pr}`,
      pr: fixture.pr,
      fixture,
      sequence:
        index % 2 === 0
          ? ["incumbent", "candidate"]
          : ["candidate", "incumbent"],
    })),
  });
  return {
    campaign_id: "campaign-1",
    candidate: { id: candidateId },
    // The bars this panel derives, never a copy of them: a threshold change
    // has to move these cases through `experimentPolicy`, not past it.
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

const holdoutSpecs = [
  {
    pr: 1,
    incumbent: { known: 4, p1: 3 },
    candidate: { known: 1, p1: 1 },
  },
  {
    pr: 2,
    incumbent: { known: 1, p1: 0 },
    candidate: { known: 3, p1: 1 },
  },
  {
    pr: 3,
    incumbent: { known: 2, p1: 0 },
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

test("screen and live-paired apply the paired recall thresholds", () => {
  const campaign = plan();
  const screen = records(campaign, "screen", screenSpecs);
  const passed = decide(campaign, "screen", { screen });
  assert.equal(passed.status, "PROMISING");
  assert.deepEqual(passed.metrics.known, {
    incumbent: 5,
    candidate: 7,
    net: 2,
  });
  assert.equal(passed.metrics.p1.net, 3);
  assert.equal(passed.metrics.nonnegative_prs, 2);
  assert.deepEqual(passed.novelty, {
    required: false,
    deferred: true,
    reason: "novelty classification is not required",
  });

  const live = records(campaign, "live-paired", screenSpecs);
  assert.equal(
    decide(campaign, "live-paired", { "live-paired": live }).status,
    "PROMISING",
  );

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

test("screen defers novelty only after known matching passes", () => {
  const campaign = plan();
  const inflated = records(campaign, "screen", screenSpecs);
  inflated.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  ).claims_count += 1;
  const deferred = decide(campaign, "screen", { screen: inflated });
  assert.equal(deferred.status, "INCONCLUSIVE");
  assert.equal(deferred.novelty.required, true);
  assert.equal(deferred.novelty.deferred, true);

  const classified = inflated.map((record) => ({ ...record, wrong_claims: 0 }));
  const passed = decide(campaign, "screen", { screen: classified });
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.novelty.required, true);
  assert.equal(passed.novelty.deferred, false);

  classified.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  ).wrong_claims = 2;
  assert.equal(
    decide(campaign, "screen", { screen: classified }).status,
    "REJECT",
  );
});

test("holdout finalists require novelty and pass the combined 9-of-12 gate", () => {
  const campaign = plan();
  const unclassified = {
    screen: records(campaign, "screen", screenSpecs),
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
    screen: records(campaign, "screen", screenSpecs, { classify: true }),
    holdout: records(campaign, "holdout", holdoutSpecs, { classify: true }),
  };
  const passed = decide(campaign, "holdout", classified);
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.metrics.known.net, 3);
  assert.equal(passed.metrics.p1.candidate, 9);
  assert.equal(passed.metrics.p1.net, 4);
  assert.equal(passed.metrics.gaining_prs, 2);
  assert.equal(passed.metrics.wrong_claims.net, 1);

  const knownShort = structuredClone(classified);
  knownShort.holdout
    .find((record) => record.pr === 3 && record.treatment === "candidate")
    .matched_ids.pop();
  assert.equal(decide(campaign, "holdout", knownShort).status, "INCONCLUSIVE");

  const p1Floor = structuredClone(classified);
  p1Floor.screen.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  ).matched_ids[0] = 105;
  const floorDecision = decide(campaign, "holdout", p1Floor);
  assert.equal(floorDecision.metrics.p1.candidate, 8);
  assert.equal(floorDecision.status, "INCONCLUSIVE");

  const p1Net = structuredClone(classified);
  for (const [stage, pr, replacement] of [
    ["screen", 1, 101],
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
  assert.equal(p1NetDecision.metrics.p1.candidate, 9);
  assert.equal(p1NetDecision.metrics.p1.net, 1);
  assert.equal(p1NetDecision.status, "INCONCLUSIVE");

  const narrowGains = structuredClone(classified);
  const candidate2 = narrowGains.holdout.find(
    (record) => record.pr === 2 && record.treatment === "candidate",
  );
  candidate2.matched_ids.pop();
  candidate2.claims_count -= 1;
  const candidate3 = narrowGains.holdout.find(
    (record) => record.pr === 3 && record.treatment === "candidate",
  );
  candidate3.matched_ids.push(305);
  candidate3.claims_count += 1;
  const gainsDecision = decide(campaign, "holdout", narrowGains);
  assert.equal(gainsDecision.metrics.known.net, 3);
  assert.equal(gainsDecision.metrics.gaining_prs, 1);
  assert.equal(gainsDecision.status, "INCONCLUSIVE");

  classified.screen.find(
    (record) => record.pr === 1 && record.treatment === "candidate",
  ).wrong_claims = 1;
  assert.equal(decide(campaign, "holdout", classified).status, "REJECT");
});

test("the paired rule reads the panel's own bar and reports the flip test", () => {
  const campaign = plan();
  const bar = campaign.policy.screen.known_net_min;
  // A loss the size of the bar is a regression; one short of it is not.
  const lost = (net) =>
    decide(campaign, "screen", {
      screen: records(
        campaign,
        "screen",
        screenSpecs.map((spec, index) => ({
          ...spec,
          incumbent: { known: 4, p1: 1 },
          candidate: { known: index === 0 ? 4 - net : 4, p1: 1 },
        })),
      ),
    });
  const atBar = lost(bar);
  assert.equal(atBar.metrics.known.net, -bar);
  assert.equal(atBar.status, "REJECT");
  const shortOfBar = lost(bar - 1);
  assert.equal(shortOfBar.status, "INCONCLUSIVE");
  // One lane differs, so half the flip assignments reach the observed sum.
  assert.deepEqual(shortOfBar.metrics.sign_flip, {
    pairs: 3,
    informative_pairs: 1,
    p_value: 0.5,
  });

  // The diagnostic is reported beside a passing verdict, never against it.
  const passed = decide(campaign, "screen", {
    screen: records(campaign, "screen", screenSpecs),
  });
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.metrics.sign_flip.informative_pairs, 2);
  assert.equal(passed.metrics.sign_flip.p_value > 0, true);
});

test("the sign-flip diagnostic is exact, one-sided, and bounded", () => {
  assert.equal(signFlipPValue([0, 0, 0]), 1);
  // A tied pair cancels out of both tails; a loss reads its own tail.
  assert.equal(signFlipPValue([0, 2, 0, 2]), 0.25);
  assert.equal(signFlipPValue([-3, 1]), 0.5);
  assert.equal(signFlipPValue(Array.from({ length: 20 }, () => 1)), 2 ** -20);
  assert.equal(signFlipPValue(Array.from({ length: 21 }, () => 1)), null);
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
