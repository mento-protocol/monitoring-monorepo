// The screens this lane has already read, decided again by today's rule.
//
// Each case below is a screen the incumbent and a candidate actually produced
// on PRs 1990, 1995 and 1999 at one draw, before the grid widened. The plan
// they are replayed through is narrowed to those three fixtures, because that
// is the panel these counts were drawn from and the panel their thresholds
// derive from. They are the regression guard for the paired rule: a threshold
// change that flips one of these verdicts has to say so here first. The bar
// the live grid sets is checked separately, at the foot of this file.
//
// None of them promotes any more. The sign-flip test now binds at every width,
// and three lanes cannot reach a 0.10 alpha: three same-direction differences
// floor at 1/8, and the screen with the largest net here has only two that
// differ, at 1/4. That is the intended consequence of the rule, not a
// regression in it — the incumbent alone drew 15, 18, 16, 16 and 17 known
// matches on these same inputs, so a three-lane panel was measuring its own
// verifier spread.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { buildExperimentPlan } from "./review-eval-experiment-contract.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import { gridFixtures } from "./review-eval-fixtures.mjs";
import { experimentPolicy } from "./review-eval-experiment-stats.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractBytes = readFileSync(
  path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
);
const contract = JSON.parse(contractBytes);
const contractDigest = createHash("sha256").update(contractBytes).digest("hex");
const root = mkdtempSync(path.join(os.tmpdir(), "review-experiment-screens-"));
after(() => rmSync(root, { recursive: true, force: true }));

for (const name of ["incumbent", "candidate"]) {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, "SKILL.md"), `${name}\n`);
}

const RECORDED_PRS = [1990, 1995, 1999];

/** The contract as it stood when these screens ran: three grid fixtures. */
const recordedContract = structuredClone(contract);
for (const fixture of recordedContract.fixtures) {
  fixture.grid = fixture.grid === true && RECORDED_PRS.includes(fixture.pr);
  if (!fixture.grid) fixture.finder_reports = [];
}

const skills = {
  incumbent: { skill_ref: path.join(root, "incumbent") },
  candidate: { id: "candidate-a", skill_ref: path.join(root, "candidate") },
  cliVersions: { claude: "claude 2.1.259", codex: "codex 0.152.0" },
  plannedAt: "2026-09-04T08:00:00.000Z",
};

const plan = buildExperimentPlan({
  contract: recordedContract,
  contractDigest,
  ...skills,
});

// Claim counts are held equal across the arms so no case turns on claim
// inflation; every verdict below is decided by the paired matches alone.
const CLAIMS = 24;

function arm(lane, treatment, { known, p1 }) {
  const p1Ids = lane.fixture.p1_ids.slice(0, p1);
  const ordinary = lane.fixture.scorable_ids.filter(
    (id) => !lane.fixture.p1_ids.includes(id),
  );
  const matched = [...p1Ids, ...ordinary.slice(0, known - p1)];
  assert.equal(matched.length, known, `PR ${lane.pr} cannot match ${known}`);
  return {
    ok: true,
    campaign_id: plan.campaign_id,
    candidate_id: plan.candidate.id,
    stage: "screen",
    cell_id: `${lane.lane_id}-${treatment}`,
    pr: lane.pr,
    treatment,
    claims_count: CLAIMS,
    matched_ids: matched,
    leak: { suspected: false },
    empty: false,
  };
}

/** One screen, as `pr -> [incumbent, candidate]` known and P1 counts. */
function screen(byPr) {
  return plan.stages.screen.lanes.flatMap((lane) => {
    const [incumbent, candidate] = byPr[lane.pr];
    return [
      arm(lane, "incumbent", incumbent),
      arm(lane, "candidate", candidate),
    ];
  });
}

function decide(records) {
  return evaluateExperimentDecision({
    plan,
    candidateId: plan.candidate.id,
    stage: "screen",
    recordsByStage: { screen: records },
  });
}

test("the recorded screens keep their verdicts under the paired rule", () => {
  // 15 -> 19 known, 4 -> 5 P1, per-PR nets +2, +2, 0. Every recall bar passes
  // and the panel is still too narrow to promote.
  const netGain = decide(
    screen({
      1990: [
        { known: 3, p1: 2 },
        { known: 5, p1: 3 },
      ],
      1995: [
        { known: 4, p1: 1 },
        { known: 6, p1: 1 },
      ],
      1999: [
        { known: 8, p1: 1 },
        { known: 8, p1: 1 },
      ],
    }),
  );
  assert.deepEqual(netGain.metrics.known, {
    incumbent: 15,
    candidate: 19,
    net: 4,
  });
  assert.deepEqual(netGain.metrics.p1, {
    incumbent: 4,
    candidate: 5,
    net: 1,
  });
  assert.deepEqual(
    netGain.metrics.pairs.map((pair) => [pair.pr, pair.d]),
    [
      [1990, 2],
      [1995, 2],
      [1999, 0],
    ],
  );
  // The net, the P1 floor and the per-PR bar all pass. Two lanes differ, so
  // the flip distribution is four assignments wide and one of them reaches the
  // observed sum: 0.25 against a 0.10 alpha, which the reason names.
  assert.equal(netGain.metrics.permutation.n, 3);
  assert.equal(netGain.metrics.permutation.pairs, 3);
  assert.equal(netGain.metrics.permutation.informative_pairs, 2);
  assert.equal(netGain.metrics.permutation.p_greater, 0.25);
  assert.equal(netGain.metrics.thresholds.known_net_min, 2);
  assert.equal(netGain.metrics.known.net >= 2, true);
  assert.equal(netGain.status, "INCONCLUSIVE");
  assert.deepEqual(netGain.reasons, [
    "paired sign-flip significance missed: p 0.2500 vs alpha 0.1 " +
      "(informative pairs 2)",
  ]);

  // 16 -> 16: nothing moved.
  const flat = decide(
    screen({
      1990: [
        { known: 5, p1: 2 },
        { known: 5, p1: 2 },
      ],
      1995: [
        { known: 5, p1: 1 },
        { known: 5, p1: 1 },
      ],
      1999: [
        { known: 6, p1: 1 },
        { known: 6, p1: 1 },
      ],
    }),
  );
  assert.equal(flat.metrics.known.net, 0);
  assert.equal(flat.status, "INCONCLUSIVE");
  // No lane differs, so there is no direction to test: the flip check is
  // skipped and the net alone carries the verdict.
  assert.equal(flat.metrics.permutation.informative_pairs, 0);
  assert.deepEqual(flat.reasons, ["known net missed"]);

  // 17 -> 18, P1 4 -> 4, per-PR nets +1, 0, 0: one match short of the bar.
  const shallow = decide(
    screen({
      1990: [
        { known: 4, p1: 2 },
        { known: 5, p1: 2 },
      ],
      1995: [
        { known: 5, p1: 1 },
        { known: 5, p1: 1 },
      ],
      1999: [
        { known: 8, p1: 1 },
        { known: 8, p1: 1 },
      ],
    }),
  );
  assert.equal(shallow.metrics.known.net, 1);
  assert.equal(shallow.metrics.p1.net, 0);
  assert.equal(shallow.status, "INCONCLUSIVE");
  assert.deepEqual(shallow.reasons, [
    "known net missed",
    "paired sign-flip significance missed: p 0.5000 vs alpha 0.1 " +
      "(informative pairs 1)",
  ]);

  // 18 -> 17 known and 5 -> 4 P1: a P1 loss is a rejection whatever the net.
  const rejected = decide(
    screen({
      1990: [
        { known: 5, p1: 3 },
        { known: 5, p1: 3 },
      ],
      1995: [
        { known: 5, p1: 1 },
        { known: 4, p1: 0 },
      ],
      1999: [
        { known: 8, p1: 1 },
        { known: 8, p1: 1 },
      ],
    }),
  );
  assert.equal(rejected.metrics.known.net, -1);
  assert.equal(rejected.metrics.p1.net, -1);
  assert.equal(rejected.status, "REJECT");
  // Minus one does not reach the minus-two reject bound; the P1 loss is what
  // rejects this screen.
  assert.equal(rejected.metrics.thresholds.known_net_reject_max, -2);
  assert.deepEqual(rejected.reasons, ["P1 net regressed"]);
});

test("the screen bar is the grid's own, not a pinned pair of counts", () => {
  // The recorded panel: three fixtures, 22 scorable ids, a bar of two and a
  // reject bound of minus two at both stages.
  assert.equal(plan.policy.screen.known_net_min, 2);
  assert.equal(plan.policy.screen.known_net_reject_max, -2);
  assert.equal(plan.policy.combined.known_net_reject_max, -2);
  assert.equal(plan.policy.screen.nonnegative_prs_min, 2);
  assert.deepEqual(
    plan.stages.screen.lanes.map((lane) => lane.pr),
    RECORDED_PRS,
  );
  assert.equal(plan.stages.screen.lanes.length, RECORDED_PRS.length);
  assert.equal(plan.draws, 1);

  // The live grid is whatever the contract marks, and it sets its own bar. The
  // recorded screens above cannot move it, and it cannot move them.
  const live = buildExperimentPlan({ contract, contractDigest, ...skills });
  const liveGrid = gridFixtures(contract).sort(
    (left, right) => left.pr - right.pr,
  );
  assert.deepEqual(
    live.stages.screen.lanes.map((lane) => lane.pr),
    liveGrid.map((fixture) => fixture.pr),
  );
  assert.deepEqual(
    live.policy,
    experimentPolicy({ fixtures: liveGrid, draws: 1 }),
  );
  assert.equal(
    live.policy.screen.known_net_min >= plan.policy.screen.known_net_min,
    true,
  );
});
