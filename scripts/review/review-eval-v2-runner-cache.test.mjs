import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./review-eval-v2-runner.mjs";

async function cachedCampaign(
  context,
  finalText = () => "No findings.",
  streamText = finalText,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "v2-cached-campaign-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = path.join(directory, "repo");
  cpSync(
    path.join(REPO_ROOT, "scripts/review"),
    path.join(copy, "scripts/review"),
    { recursive: true },
  );
  cpSync(
    path.join(REPO_ROOT, "docs/evals/review-skill-v2"),
    path.join(copy, "docs/evals/review-skill-v2"),
    { recursive: true },
  );
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "claude"),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const moduleUrl = (file) =>
    pathToFileURL(path.join(copy, "scripts/review", file)).href;
  const runner = await import(moduleUrl("review-eval-v2-runner.mjs"));
  const scorer = await import(moduleUrl("review-eval-v2-score.mjs"));
  const cache = await import(moduleUrl("review-eval-experiment-cache.mjs"));
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  const datasetFile = path.join(
    copy,
    "docs/evals/review-skill-v2/dataset.json",
  );
  const dataset = JSON.parse(readFileSync(datasetFile, "utf8"));
  const out = path.join(directory, "campaign");
  const plan = runner.makePlan({
    datasetFile,
    incumbent: skillDir,
    candidate: skillDir,
    out,
  });
  const rawDigests = [];
  const scoreDigest = scorer.scorerDigestV2();
  for (const cell of plan.cells) {
    const fixture = dataset.cases.find((item) => item.id === cell.case_id);
    const final = finalText(fixture);
    const envelope = {
      is_error: false,
      result: final,
      duration_ms: 1,
      total_cost_usd: null,
    };
    const raw = cache.writeExperimentCache({
      artifactRoot: out,
      kind: "raw",
      identity: runner.executionIdentity({
        plan,
        fixture,
        treatment: cell.treatment,
      }),
      payload: {
        final_text: final,
        stream: JSON.stringify({
          type: "result",
          ...envelope,
          result: streamText(fixture),
        }),
        envelope,
        completed: true,
        output_contract: plan.output_contract,
        source_state: "unused-cached-source",
      },
    });
    rawDigests.push(raw.artifact.content_digest);
    cache.writeExperimentCache({
      artifactRoot: out,
      kind: "score",
      identity: runner.scoringIdentity({
        rawDigest: raw.artifact.content_digest,
        datasetDigest: plan.dataset_digest,
        scorerDigest: scoreDigest,
        model: plan.model,
        effort: plan.effort,
        version: plan.cli_version,
      }),
      payload: {
        status: "complete",
        errors: [],
        claims: [],
        defects: [],
        novel: [],
      },
    });
  }
  return {
    directory,
    copy,
    out,
    runner,
    scorer,
    plan,
    dataset,
    rawDigests,
    scoreDigest,
    moduleUrl,
  };
}

test("result-only and separately stored final text are checked before cached grades", async (context) => {
  for (const mode of ["result-only", "final-artifact-only", "clean"]) {
    await context.test(mode, async (child) => {
      const text = (fixture) =>
        mode === "clean"
          ? "No findings."
          : `No findings. ${" ".repeat(120_001)} ${fixture.forbidden_shas[0]}`;
      const c = await cachedCampaign(
        child,
        text,
        mode === "final-artifact-only" ? () => "No findings." : text,
      );
      const report = await c.runner.runCampaign({
        out: c.out,
        scoreOnly: true,
      });
      if (mode === "clean") {
        assert.equal(report.status, "completed");
        assert.ok(
          report.rows.every((row) => row.raw_reused && row.score_reused),
        );
      } else {
        assert.equal(report.status, "incomplete");
        assert.match(
          report.failure,
          /possible answer-key leak.*withheld commit/,
        );
        assert.equal(report.completed_cells, 0);
      }
      assert.equal(report.cost.actual_known_usd, 0);
      assert.equal(existsSync(path.join(c.out, "spend.json")), false);
    });
  }
});

function freshRescore(c, selectorFile = "review-eval-v2-selection.mjs") {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {readFileSync} from 'node:fs';
    const [runner, scorer, cache, selector] = await Promise.all(${JSON.stringify([c.moduleUrl("review-eval-v2-runner.mjs"), c.moduleUrl("review-eval-v2-score.mjs"), c.moduleUrl("review-eval-experiment-cache.mjs"), c.moduleUrl(selectorFile)])}.map(url => import(url)));
    const out = ${JSON.stringify(c.out)};
    const plan = JSON.parse(readFileSync(out + '/plan.json', 'utf8'));
    const dataset = JSON.parse(readFileSync(plan.dataset_file, 'utf8'));
    const digest = scorer.scorerDigestV2();
    const raws = [];
    for (const cell of plan.cells) {
      const fixture = dataset.cases.find(item => item.id === cell.case_id);
      const raw = cache.readExperimentCache({artifactRoot:out, kind:'raw', identity:runner.executionIdentity({plan, fixture, treatment:cell.treatment})});
      if (!raw) throw new Error('raw identity changed');
      raws.push(raw.artifact.content_digest);
      cache.writeExperimentCache({artifactRoot:out, kind:'score', identity:runner.scoringIdentity({rawDigest:raw.artifact.content_digest, datasetDigest:plan.dataset_digest, scorerDigest:digest, model:plan.model, effort:plan.effort, version:plan.cli_version}), payload:{status:'complete', errors:[], claims:[], defects:[], novel:[]}});
    }
    const repaired = dataset.cases.find(item => item.variant === 'repaired');
    const report = await runner.runCampaign({out, scoreOnly:true});
    process.stdout.write(JSON.stringify({report, digest, raws, repairedRoots:selector.rootsForCase(dataset,repaired.id)}));
  `,
      ],
      { encoding: "utf8", env: process.env },
    ),
  );
}

function providerArguments(c) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {existsSync} from 'node:fs';
    import {EventEmitter} from 'node:events';
    import {PassThrough} from 'node:stream';
    const {createProvider} = await import(${JSON.stringify(c.moduleUrl("review-eval-v2-provider.mjs"))});
    const judgeFile = ${JSON.stringify(path.join(c.copy, "scripts/review/review-eval-v2-judge-provider.mjs"))};
    const invokeJudge = existsSync(judgeFile) ? (await import(${JSON.stringify(c.moduleUrl("review-eval-v2-judge-provider.mjs"))})).invokeJudge : (provider, request) => provider.invoke(request);
    const calls = [];
    const provider = createProvider({out:${JSON.stringify(path.join(c.directory, "argument-probe"))}, repoRoot:${JSON.stringify(c.copy)}, version:'test', env:{}, verifyPolicy:()=>{},
      execAuth:()=>JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}),
      spawnProcess:(name,args)=>{
        calls.push(args);
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill=()=>{};
        queueMicrotask(()=>{child.stdout.write(JSON.stringify({type:'result',is_error:false,result:'Complete',total_cost_usd:0})+'\\n');child.emit('close',0);});
        return child;
      }});
    const request = {label:'probe',prompt:'Review',model:'test',effort:'high',cwd:${JSON.stringify(c.directory)}};
    await provider.invoke({...request,allowedTools:['Read','Grep','Glob'],maxTurns:60});
    await invokeJudge(provider,{...request,allowedTools:[],maxTurns:1});
    process.stdout.write(JSON.stringify(calls));
  `,
      ],
      { encoding: "utf8", env: process.env },
    ),
  );
}

test("judge-only provider changes reuse saved reviews without changing reviewer arguments", async (context) => {
  const c = await cachedCampaign(context);
  const beforeArgs = providerArguments(c);
  const split = existsSync(
    path.join(c.copy, "scripts/review/review-eval-v2-judge-provider.mjs"),
  );
  const target = path.join(
    c.copy,
    "scripts/review",
    split ? "review-eval-v2-judge-provider.mjs" : "review-eval-v2-provider.mjs",
  );
  const before = readFileSync(target, "utf8");
  const after = split
    ? before.replace(
        "return claudeArgv(request);",
        "return claudeArgv({ ...request, maxTurns: request.allowedTools.length === 0 ? request.maxTurns + 1 : request.maxTurns });",
      )
    : before.replace(
        "        maxTurns,",
        "        maxTurns: allowedTools.length === 0 ? maxTurns + 1 : maxTurns,",
      );
  assert.notEqual(
    after,
    before,
    "fault must change the blind judge turn limit",
  );
  writeFileSync(target, after);
  const afterArgs = providerArguments(c);
  assert.deepEqual(
    afterArgs[0],
    beforeArgs[0],
    "reviewer invocation is unchanged",
  );
  assert.equal(beforeArgs[1][beforeArgs[1].indexOf("--max-turns") + 1], "1");
  assert.equal(afterArgs[1][afterArgs[1].indexOf("--max-turns") + 1], "2");
  const result = freshRescore(c);
  assert.notEqual(result.digest, c.scoreDigest);
  assert.equal(result.report.status, "completed");
  assert.ok(
    result.report.rows.every((row) => row.raw_reused && row.score_reused),
  );
  assert.deepEqual(result.raws, c.rawDigests);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);
});

test("fresh-process selector changes rescore existing raw without changing execution identity", async (context) => {
  const c = await cachedCampaign(context);
  const selectorFile = existsSync(
    path.join(c.copy, "scripts/review/review-eval-v2-selection.mjs"),
  )
    ? "review-eval-v2-selection.mjs"
    : "review-eval-v2-dataset.mjs";
  const target = path.join(c.copy, "scripts/review", selectorFile);
  const before = readFileSync(target, "utf8");
  const after = before.replace("...item.negative_control_root_ids,", "");
  assert.notEqual(
    after,
    before,
    "fault must alter grading-only root selection",
  );
  writeFileSync(target, after);
  const result = freshRescore(c, selectorFile);
  assert.notEqual(result.digest, c.scoreDigest);
  assert.deepEqual(result.repairedRoots, []);
  assert.equal(result.report.status, "completed");
  assert.ok(
    result.report.rows.every((row) => row.raw_reused && row.score_reused),
  );
  assert.deepEqual(result.raws, c.rawDigests);
  assert.equal(result.report.cost.actual_known_usd, 0);
});

test("loaded scoring drift replaces a prior completed report with durable incomplete evidence", async (context) => {
  const c = await cachedCampaign(context);
  const complete = await c.runner.runCampaign({ out: c.out, scoreOnly: true });
  assert.equal(complete.status, "completed");
  const scores = path.join(c.out, "cache/score");
  const cacheBytes = () =>
    Object.fromEntries(
      readdirSync(scores)
        .sort()
        .map((file) => [file, readFileSync(path.join(scores, file), "utf8")]),
    );
  const before = cacheBytes();
  const reducer = path.join(c.copy, "scripts/review/review-eval-v2-report.mjs");
  writeFileSync(
    reducer,
    `${readFileSync(reducer, "utf8")}\n// changed after scoring modules loaded\n`,
  );
  const report = await c.runner.runCampaign({ out: c.out, scoreOnly: true });
  assert.equal(report.status, "incomplete");
  assert.match(report.failure, /scoring source changed/);
  assert.equal(report.metrics, null);
  assert.deepEqual(report.rows, []);
  assert.equal(report.completed_cells, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(c.out, "report.json"), "utf8")),
    report,
  );
  assert.deepEqual(cacheBytes(), before);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);
});

test("grading orchestration and leak-helper changes reuse reviewer artifacts in a fresh process", async (context) => {
  for (const mode of ["grading row", "leak helper"]) {
    await context.test(mode, async (child) => {
      const c = await cachedCampaign(child);
      const file =
        mode === "leak helper"
          ? "review-eval-run-cell.mjs"
          : existsSync(
                path.join(c.copy, "scripts/review/review-eval-v2-grading.mjs"),
              )
            ? "review-eval-v2-grading.mjs"
            : "review-eval-v2-runner.mjs";
      const target = path.join(c.copy, "scripts/review", file);
      const before = readFileSync(target, "utf8");
      const after =
        mode === "leak helper"
          ? before.replace(
              "const advisory = [];",
              'const advisory = ["fault-control"];',
            )
          : before.replace(
              "score_reused: scoreReused,",
              'score_reused: scoreReused, grading_revision: "fault-control",',
            );
      assert.notEqual(after, before, "fault must alter grading behavior");
      writeFileSync(target, after);
      const result = freshRescore(c);
      assert.notEqual(result.digest, c.scoreDigest);
      assert.equal(result.report.status, "completed");
      assert.ok(
        result.report.rows.every(
          (row) =>
            row.raw_reused &&
            row.score_reused &&
            (mode === "leak helper"
              ? row.leak.advisory.includes("fault-control")
              : row.grading_revision === "fault-control"),
        ),
      );
      assert.deepEqual(result.raws, c.rawDigests);
      assert.equal(result.report.cost.actual_known_usd, 0);
      assert.equal(existsSync(path.join(c.out, "spend.json")), false);
    });
  }
});
