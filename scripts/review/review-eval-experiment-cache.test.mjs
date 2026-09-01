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
  readExperimentCache,
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
