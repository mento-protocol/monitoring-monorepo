import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gradeCell } from "./review-eval-v2-grading.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";

function setup(context, uncertain = false, artifactRoot) {
  const out =
    artifactRoot ?? mkdtempSync(path.join(os.tmpdir(), "v2-phase-cache-"));
  context.after(() => rmSync(out, { recursive: true, force: true }));
  const fixturePath = path.join(out, "source");
  mkdirSync(fixturePath, { recursive: true });
  writeFileSync(path.join(fixturePath, "code"), "unchanged source");
  const sourceState = () =>
    digestObject(readFileSync(path.join(fixturePath, "code"), "utf8"));
  const finalText = "Null input crashes. An independent call hangs.";
  const calls = [];
  const requests = [];
  const replies = {
    extraction: {
      complete: true,
      claims: [
        { text: "Null input crashes.", quote: "Null input crashes." },
        {
          text: "An independent call hangs.",
          quote: "An independent call hangs.",
        },
      ],
    },
    matching: {
      defects: [
        {
          id: "root",
          verdict: uncertain ? "uncertain" : "matched",
          claim_ids: ["c1"],
          quote: "Null input crashes.",
          reason: "Null dereference.",
        },
      ],
    },
    classification: {
      novel: [
        {
          claim_id: "c2",
          verdict: "unsupported",
          reason: "No verified trigger.",
        },
      ],
    },
  };
  const fixture = {
    id: "case",
    pr: 1,
    expected_root_ids: ["root"],
    negative_control_root_ids: [],
    forbidden_shas: [],
  };
  const state = { failure: null };
  const provider = {
    identity: {
      version: "stub",
      executable: "/stub",
      executable_sha256: "0".repeat(64),
    },
    invoke: async (request) => {
      const phase = request.allowedTools.length
        ? "classification"
        : request.prompt.includes("<defects>")
          ? "matching"
          : "extraction";
      calls.push(phase);
      requests.push({ model: request.model, effort: request.effort });
      if (state.failure?.phase === phase) {
        if (state.failure.kind === "provider")
          throw new Error("provider unavailable");
        return { envelope: { is_error: false, result: JSON.stringify({}) } };
      }
      return {
        envelope: { is_error: false, result: JSON.stringify(replies[phase]) },
      };
    },
  };
  const args = {
    out,
    provider,
    fixture,
    plan: {
      model: "stub",
      effort: "high",
      output_contract: "final-consolidated-v1",
    },
    cell: { case_id: "case", treatment: "incumbent" },
    loaded: {
      digest: "dataset",
      dataset: {
        cases: [fixture],
        roots: [{ id: "root", title: "Null dereference" }],
      },
    },
    raw: {
      artifact: { content_digest: "raw" },
      file: "raw.json",
      payload: {
        completed: true,
        output_contract: "final-consolidated-v1",
        final_text: finalText,
        envelope: { is_error: false },
        stream: JSON.stringify({
          type: "result",
          is_error: false,
          result: finalText,
        }),
        source_state: sourceState(),
      },
    },
    reused: true,
    prepare: () => ({ path: fixturePath }),
    sourceState,
    sourceDiff: () => "complete unchanged diff",
  };
  const artifacts = () =>
    (existsSync(path.join(out, "cache/stage"))
      ? readdirSync(path.join(out, "cache/stage"))
      : []
    ).map((file) => ({
      file: path.join(out, "cache/stage", file),
      artifact: JSON.parse(
        readFileSync(path.join(out, "cache/stage", file), "utf8"),
      ),
    }));
  return { args, state, calls, requests, artifacts };
}

test("resume keeps validated phases after later provider or malformed-output failure", async (context) => {
  for (const phase of ["matching", "classification"])
    for (const kind of ["provider", "malformed"]) {
      await context.test(`${phase}/${kind}`, async (child) => {
        const s = setup(child);
        s.state.failure = { phase, kind };
        await assert.rejects(gradeCell(s.args), /grading failed/);
        const saved = s.artifacts();
        assert.equal(saved.length, phase === "matching" ? 1 : 2);
        const savedBytes = saved.map(({ file }) => readFileSync(file, "utf8"));
        s.state.failure = null;
        s.calls.length = 0;
        const row = await gradeCell(s.args);
        assert.equal(row.score.status, "complete");
        assert.deepEqual(
          s.calls,
          phase === "matching"
            ? ["matching", "classification"]
            : ["classification"],
        );
        assert.deepEqual(
          saved.map(({ file }) => readFileSync(file, "utf8")),
          savedBytes,
        );
        s.calls.length = 0;
        assert.equal((await gradeCell(s.args)).score_reused, true);
        assert.deepEqual(s.calls, []);
      });
    }
});

test("valid uncertain matches survive a later phase failure without a new judgment", async (context) => {
  const s = setup(context, true);
  s.state.failure = { phase: "classification", kind: "provider" };
  await assert.rejects(gradeCell(s.args), /grading failed/);
  s.state.failure = null;
  s.calls.length = 0;
  const row = await gradeCell(s.args);
  assert.deepEqual(s.calls, ["classification"]);
  assert.equal(row.score.status, "incomplete");
  assert.equal(row.score.defects[0].verdict, "uncertain");
  assert.deepEqual(row.score.errors, []);
});

test("raw, dataset, and grading runtime changes cannot reuse earlier phase judgments", async (context) => {
  for (const input of ["raw", "dataset", "runtime", "model", "effort"])
    await context.test(input, async (child) => {
      const s = setup(child);
      s.state.failure = { phase: "classification", kind: "provider" };
      await assert.rejects(gradeCell(s.args), /grading failed/);
      if (input === "raw") s.args.raw.artifact.content_digest = "other-raw";
      if (input === "dataset") s.args.loaded.digest = "other-dataset";
      if (input === "runtime")
        s.args.provider.identity.executable_sha256 = "1".repeat(64);
      const originalPlan = structuredClone(s.args.plan);
      const originalRaw = structuredClone(s.args.raw);
      if (input === "model" || input === "effort") {
        s.args.gradingSettings = {
          model: s.args.plan.model,
          effort: s.args.plan.effort,
        };
        s.args.gradingSettings[input] =
          input === "model" ? "other-model" : "low";
      }
      s.state.failure = null;
      s.calls.length = 0;
      s.requests.length = 0;
      assert.equal((await gradeCell(s.args)).score.status, "complete");
      assert.deepEqual(s.calls, ["extraction", "matching", "classification"]);
      assert.deepEqual(
        s.requests,
        Array(3).fill(
          s.args.gradingSettings ?? {
            model: s.args.plan.model,
            effort: s.args.plan.effort,
          },
        ),
      );
      assert.deepEqual(s.args.plan, originalPlan);
      assert.deepEqual(s.args.raw, originalRaw);
    });
});

test("cached phases must still pass semantic validation", async (context) => {
  const s = setup(context);
  s.state.failure = { phase: "classification", kind: "provider" };
  await assert.rejects(gradeCell(s.args), /grading failed/);
  const saved = s
    .artifacts()
    .find(({ artifact }) => artifact.payload.parsed.claims);
  saved.artifact.payload.parsed.claims[0].quote = "fabricated quote";
  const { content_digest: discarded, ...body } = saved.artifact;
  void discarded;
  writeFileSync(
    saved.file,
    JSON.stringify({ ...body, content_digest: digestObject(body) }),
  );
  s.state.failure = null;
  s.calls.length = 0;
  await assert.rejects(gradeCell(s.args), /quote is absent/);
  assert.deepEqual(
    s.calls,
    [],
    "invalid cached extraction must not reach later phases",
  );
});

test("fresh-process resume reuses blind extraction and matching despite a new isolated cwd", async (context) => {
  const s = setup(context);
  s.state.failure = { phase: "classification", kind: "provider" };
  await assert.rejects(gradeCell(s.args), /grading failed/);
  const resumed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
    import os from "node:os";
    import path from "node:path";
    const {gradeCell} = await import(${JSON.stringify(new URL("./review-eval-v2-grading.mjs", import.meta.url).href)});
    const {digestObject} = await import(${JSON.stringify(new URL("./review-eval-experiment-contract.mjs", import.meta.url).href)});
    const setup = ${setup.toString()};
    const s = setup({after:()=>{}}, false, ${JSON.stringify(s.args.out)});
    const row = await gradeCell(s.args);
    process.stdout.write(JSON.stringify({calls:s.calls,status:row.score.status}));
  `,
      ],
      { env: {}, encoding: "utf8" },
    ),
  );
  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.calls, ["classification"]);
});
