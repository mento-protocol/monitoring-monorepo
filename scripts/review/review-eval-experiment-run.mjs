// Fixture-lane orchestration for the non-ledger experiment runner.

import { MAX_FIXTURE_LANES } from "./review-eval-experiment-contract.mjs";
import {
  stagePlanFor,
  validateStageAttempt,
} from "./review-eval-experiment-evidence.mjs";

function validArmResult(result, lane, arm) {
  return (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    result.ok === true &&
    result.malformed !== true &&
    result.pr === lane.pr &&
    result.treatment === arm.treatment &&
    Number.isSafeInteger(result.claims_count) &&
    result.claims_count >= 0 &&
    Array.isArray(result.matched_ids)
  );
}

async function mapLanes(lanes, concurrency, worker) {
  const output = new Array(lanes.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, lanes.length) },
    async () => {
      while (next < lanes.length) {
        const index = next;
        next += 1;
        output[index] = await worker(lanes[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

/**
 * Run at most three PR lanes together. The two paired arms in one lane always
 * await each other in the order recorded by the immutable campaign plan.
 */
export async function runExperimentStage({
  plan,
  candidateId,
  stage,
  attempt = 1,
  priorAttempts = [],
  execute,
  concurrency = MAX_FIXTURE_LANES,
  dryRun = false,
}) {
  const allowed = validateStageAttempt({ attempt, priorAttempts });
  if (!allowed.ok) throw new Error(allowed.reason);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_FIXTURE_LANES
  ) {
    throw new Error(`fixture lane concurrency must be 1..${MAX_FIXTURE_LANES}`);
  }
  const stagePlan = stagePlanFor({ plan, candidateId, stage });
  if (dryRun) {
    return {
      dry_run: true,
      candidate_id: candidateId,
      stage,
      attempt,
      concurrency,
      lanes: stagePlan.lanes.map((lane) => ({
        lane_id: lane.lane_id,
        pr: lane.pr,
        paired_order: lane.paired_order,
        sequence: lane.sequence.map((arm) => arm.treatment),
      })),
      records: [],
    };
  }
  if (typeof execute !== "function") {
    throw new TypeError("execute must be an async arm function");
  }
  const laneRecords = await mapLanes(
    stagePlan.lanes,
    concurrency,
    async (lane, laneIndex) => {
      const records = [];
      for (const [armIndex, arm] of lane.sequence.entries()) {
        const record = await execute({
          plan,
          candidateId,
          stage,
          attempt,
          lane,
          laneIndex,
          arm,
          armIndex,
        });
        if (!validArmResult(record, lane, arm)) {
          throw new Error(
            `${lane.lane_id} ${arm.treatment} returned an incomplete or mismatched artifact`,
          );
        }
        records.push(record);
      }
      return records;
    },
  );
  return {
    dry_run: false,
    candidate_id: candidateId,
    stage,
    attempt,
    concurrency,
    lanes: stagePlan.lanes.map((lane) => ({
      lane_id: lane.lane_id,
      pr: lane.pr,
      paired_order: lane.paired_order,
      sequence: lane.sequence.map((arm) => arm.treatment),
    })),
    records: laneRecords.flat(),
  };
}
