import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  experimentCacheFile,
  mapExperimentLimit,
  readExperimentCache,
  validateNovelExperimentPayload,
  validateScoreExperimentPayload,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";

function identity(phase, marker = "one") {
  const inputs = { phase, marker };
  return { ...inputs, digest: digestObject(inputs) };
}

function withRoot(run) {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-cache-"),
  );
  try {
    return run(artifactRoot);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

test("bounded work stops assigning lanes after the first failure", async () => {
  let releaseSecond;
  let secondStarted;
  const secondReady = new Promise((resolve) => {
    secondStarted = resolve;
  });
  const secondRelease = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const starts = [];
  const run = mapExperimentLimit([0, 1, 2], 2, async (value) => {
    starts.push(value);
    if (value === 0) {
      await secondReady;
      throw new Error("lane zero failed");
    }
    if (value === 1) {
      secondStarted();
      await secondRelease;
    }
    return value;
  });
  const rejected = assert.rejects(run, /lane zero failed/);
  await secondReady;
  await new Promise((resolve) => setImmediate(resolve));
  releaseSecond();
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1]);
});

test("experiment cache publishes and reuses one exact identity", () =>
  withRoot((artifactRoot) => {
    const rawIdentity = identity("raw");
    const first = writeExperimentCache({
      artifactRoot,
      kind: "raw",
      identity: rawIdentity,
      payload: { output: "review" },
    });
    assert.equal(first.reused, false);
    assert.equal(
      first.file,
      experimentCacheFile({
        artifactRoot,
        kind: "raw",
        identity: rawIdentity,
      }),
    );
    assert.deepEqual(first.payload, { output: "review" });

    const second = writeExperimentCache({
      artifactRoot,
      kind: "raw",
      identity: rawIdentity,
      payload: { output: "review" },
    });
    assert.equal(second.reused, true);
    assert.equal(
      readdirSync(path.dirname(first.file)).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
    assert.throws(
      () =>
        writeExperimentCache({
          artifactRoot,
          kind: "raw",
          identity: rawIdentity,
          payload: { output: "different" },
        }),
      /different content/,
    );
  }));

test("a concurrent different payload cannot replace the published winner", () =>
  withRoot((artifactRoot) => {
    const rawIdentity = identity("raw", "race");
    assert.throws(
      () =>
        writeExperimentCache({
          artifactRoot,
          kind: "raw",
          identity: rawIdentity,
          payload: { output: "loser" },
          beforePublish: () =>
            writeExperimentCache({
              artifactRoot,
              kind: "raw",
              identity: rawIdentity,
              payload: { output: "winner" },
            }),
        }),
      /different content/,
    );
    assert.deepEqual(
      readExperimentCache({
        artifactRoot,
        kind: "raw",
        identity: rawIdentity,
      }).payload,
      { output: "winner" },
    );

    const sameIdentity = identity("raw", "same-race");
    const same = writeExperimentCache({
      artifactRoot,
      kind: "raw",
      identity: sameIdentity,
      payload: { output: "same" },
      beforePublish: () =>
        writeExperimentCache({
          artifactRoot,
          kind: "raw",
          identity: sameIdentity,
          payload: { output: "same" },
        }),
    });
    assert.equal(same.reused, true);
  }));

test("experiment cache rejects content and identity tampering", () =>
  withRoot((artifactRoot) => {
    const scoreIdentity = identity("score");
    const entry = writeExperimentCache({
      artifactRoot,
      kind: "score",
      identity: scoreIdentity,
      payload: { matched_ids: [1] },
    });
    const artifact = JSON.parse(readFileSync(entry.file, "utf8"));
    writeFileSync(
      entry.file,
      `${JSON.stringify({
        ...artifact,
        payload: { matched_ids: [2] },
      })}\n`,
    );
    assert.throws(
      () =>
        readExperimentCache({
          artifactRoot,
          kind: "score",
          identity: scoreIdentity,
        }),
      /mismatched content digest/,
    );

    const forgedIdentity = identity("score", "forged");
    const forgedBase = {
      ...artifact,
      identity: forgedIdentity,
      payload: { matched_ids: [2] },
    };
    delete forgedBase.content_digest;
    writeFileSync(
      entry.file,
      `${JSON.stringify({
        ...forgedBase,
        content_digest: digestObject(forgedBase),
      })}\n`,
    );
    assert.throws(
      () =>
        readExperimentCache({
          artifactRoot,
          kind: "score",
          identity: scoreIdentity,
        }),
      /mismatched identity/,
    );
  }));

test("experiment cache ignores incomplete temporary files", () =>
  withRoot((artifactRoot) => {
    const novelIdentity = identity("novel");
    const finalFile = experimentCacheFile({
      artifactRoot,
      kind: "novel",
      identity: novelIdentity,
    });
    mkdirSync(path.dirname(finalFile), { recursive: true });
    const temporary = path.join(
      path.dirname(finalFile),
      `.${path.basename(finalFile)}.interrupted.tmp`,
    );
    writeFileSync(temporary, '{"schema_version":1');
    assert.equal(
      readExperimentCache({
        artifactRoot,
        kind: "novel",
        identity: novelIdentity,
      }),
      null,
    );
    const entry = writeExperimentCache({
      artifactRoot,
      kind: "novel",
      identity: novelIdentity,
      payload: { verdict: "real" },
    });
    assert.equal(existsSync(entry.file), true);
    assert.equal(existsSync(temporary), true);
  }));

test("generic cache accepts a stage result identity", () =>
  withRoot((artifactRoot) => {
    const stageIdentity = identity("stage");
    const entry = writeExperimentCache({
      artifactRoot,
      kind: "stage",
      identity: stageIdentity,
      payload: { records: [], decision: { status: "INCONCLUSIVE" } },
    });
    assert.deepEqual(entry.payload.records, []);
  }));

test("payload provenance checks fail closed on both sides", () => {
  const rawDigest = "a".repeat(64);
  const scored = {
    raw_digest: rawDigest,
    cli_versions: { judge: "judge 1" },
    claims: [],
    matched_ids: [],
    leak: { suspected: false, hard: [], advisory: [] },
  };
  assert.equal(
    validateScoreExperimentPayload(scored, rawDigest, { judge: "judge 1" }, "c")
      .raw_digest,
    rawDigest,
  );

  // An omitted expected set used to skip the check and pass any provenance.
  assert.throws(
    () =>
      validateScoreExperimentPayload(scored, rawDigest, undefined, "cell-1"),
    /cell-1 score cache read supplied no CLI versions to check/,
  );
  assert.throws(
    () => validateScoreExperimentPayload(scored, rawDigest, null, "cell-1"),
    /cell-1 score cache read supplied no CLI versions to check/,
  );

  // A payload that stores no provenance is unattributable, so it is refused.
  assert.throws(
    () =>
      validateScoreExperimentPayload(
        { ...scored, cli_versions: undefined },
        rawDigest,
        { judge: "judge 1" },
        "cell-1",
      ),
    /cell-1 score cache payload records no CLI versions/,
  );
  const scoreDigest = "b".repeat(64);
  assert.throws(
    () =>
      validateNovelExperimentPayload(
        { score_digest: scoreDigest, verdict: { novelWrong: 0, novelReal: 0 } },
        scoreDigest,
        { judge: "judge 1" },
        "cell-1",
      ),
    /cell-1 novel cache payload records no CLI versions/,
  );

  // An empty provider set stays a valid recording on both sides.
  assert.equal(
    validateNovelExperimentPayload(
      {
        score_digest: scoreDigest,
        cli_versions: {},
        verdict: { novelWrong: 0, novelReal: 0 },
      },
      scoreDigest,
      {},
      "cell-1",
    ).score_digest,
    scoreDigest,
  );
});
