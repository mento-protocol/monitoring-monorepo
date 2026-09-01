// Deterministic live-finder receipts for the non-ledger experiment lane.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  experimentArtifactFile,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";

const LIVE_FINDER_HANDOFF_BYTES = 30_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function liveFinderHandoff(raw) {
  const rawText = String(raw ?? "");
  const rawBytes = Buffer.from(rawText);
  let start = Math.max(0, rawBytes.length - LIVE_FINDER_HANDOFF_BYTES);
  while (start < rawBytes.length && (rawBytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  const delivered = rawBytes.subarray(start).toString("utf8");
  return {
    raw: rawText,
    delivered,
    raw_digest: sha256(rawText),
    delivered_digest: sha256(delivered),
    raw_bytes: rawBytes.length,
    delivered_bytes: Buffer.byteLength(delivered),
  };
}

function validateFinderReceipt({ artifact, plan, lane, file }) {
  const copy = { ...artifact };
  delete copy.finder_digest;
  const handoff = liveFinderHandoff(artifact.raw_output);
  if (
    artifact.finder_digest !== digestObject(copy) ||
    artifact.schema_version !== 1 ||
    artifact.namespace !== plan.namespace ||
    artifact.campaign_id !== plan.campaign_id ||
    artifact.plan_digest !== plan.plan_digest ||
    artifact.lane_id !== lane.lane_id ||
    artifact.pr !== lane.pr ||
    artifact.finder_argv_digest !== plan.identities.finder_argv_digest ||
    artifact.raw_digest !== handoff.raw_digest ||
    artifact.delivered_digest !== handoff.delivered_digest ||
    artifact.raw_output !== handoff.raw ||
    artifact.delivered_output !== handoff.delivered ||
    artifact.raw_bytes !== handoff.raw_bytes ||
    artifact.delivered_bytes !== handoff.delivered_bytes ||
    !artifact.delivered_output.trim()
  ) {
    throw new Error(`live finder receipt ${file} failed its identity check`);
  }
  return artifact;
}

/** Reuse one published finder sample, or create it once when none exists. */
export async function ensureLiveFinderReceipt({
  plan,
  contract,
  lane,
  artifactRoot,
  fixture,
  env,
  timeoutMs,
  signal,
  beforeWrite,
  runCommand,
  isolatedCommand,
  withDisposableFixture,
}) {
  const file = experimentArtifactFile(
    artifactRoot,
    `cache/finder/${lane.lane_id}.json`,
  );
  if (existsSync(file)) {
    const artifact = validateFinderReceipt({
      artifact: JSON.parse(readFileSync(file, "utf8")),
      plan,
      lane,
      file,
    });
    return {
      text: artifact.delivered_output,
      digest: artifact.delivered_digest,
      file,
      reused: true,
    };
  }
  const response = await withDisposableFixture({
    seedFixture: fixture,
    head: lane.fixture.first_head,
    base: lane.fixture.base_sha,
    cellId: `${lane.lane_id}-finder`,
    role: "finder",
    run: async (active) => {
      const [, ...args] = contract.sut.finder.argv;
      beforeWrite?.();
      const isolated = isolatedCommand({
        file: plan.identities.codex_bin.path,
        args,
        fixturePath: active.path,
      });
      return runCommand({
        ...isolated,
        cwd: active.path,
        env,
        timeoutMs,
        signal,
      });
    },
  });
  if (!response.stdout.trim()) {
    throw new Error(`live finder returned no report for PR ${lane.pr}`);
  }
  const handoff = liveFinderHandoff(response.stdout);
  if (!handoff.delivered.trim()) {
    throw new Error(`live finder tail returned no report for PR ${lane.pr}`);
  }
  const base = {
    schema_version: 1,
    namespace: plan.namespace,
    campaign_id: plan.campaign_id,
    plan_digest: plan.plan_digest,
    lane_id: lane.lane_id,
    pr: lane.pr,
    finder_argv_digest: plan.identities.finder_argv_digest,
    raw_digest: handoff.raw_digest,
    delivered_digest: handoff.delivered_digest,
    raw_output: handoff.raw,
    delivered_output: handoff.delivered,
    raw_bytes: handoff.raw_bytes,
    delivered_bytes: handoff.delivered_bytes,
  };
  const artifact = { ...base, finder_digest: digestObject(base) };
  writeExperimentCache(file, artifact, beforeWrite);
  validateFinderReceipt({ artifact, plan, lane, file });
  return {
    text: artifact.delivered_output,
    digest: artifact.delivered_digest,
    file,
    reused: false,
  };
}
