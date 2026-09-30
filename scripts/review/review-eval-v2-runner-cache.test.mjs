import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  legacy = false,
  prepareCopy = () => {},
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
  prepareCopy({ copy, directory });
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
  if (legacy) {
    delete plan.provider_runtime;
    for (const cell of plan.cells) {
      delete cell.raw_identity;
      delete cell.raw_identity_version;
    }
    const { digestObject } = await import(
      moduleUrl("review-eval-experiment-contract.mjs")
    );
    writeFileSync(
      path.join(out, "plan.json"),
      JSON.stringify({ ...plan, plan_digest: digestObject(plan) }),
    );
  }
  const rawDigests = [];
  const rawIdentities = [];
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
    rawIdentities.push(raw.artifact.identity);
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
        runtime: runner.providerIdentity(),
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
    rawIdentities,
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
    const runtime = runner.providerIdentity();
    const raws = [];
    const priorScores = [];
    const savedIdentities = ${JSON.stringify(c.rawIdentities)};
    for (const [index, cell] of plan.cells.entries()) {
      const raw = cache.readExperimentCache({artifactRoot:out, kind:'raw', identity:savedIdentities[index]});
      if (!raw) throw new Error('raw identity changed');
      raws.push(raw.artifact.content_digest);
      const identity = runner.scoringIdentity({rawDigest:raw.artifact.content_digest, datasetDigest:plan.dataset_digest, scorerDigest:digest, model:plan.model, effort:plan.effort, version:runtime.version,runtime});
      priorScores.push(Boolean(cache.readExperimentCache({artifactRoot:out, kind:'score', identity})));
      cache.writeExperimentCache({artifactRoot:out, kind:'score', identity, payload:{status:'complete', errors:[], claims:[], defects:[], novel:[]}});
    }
    const repaired = dataset.cases.find(item => item.variant === 'repaired');
    const report = await runner.runCampaign({out, scoreOnly:true});
    process.stdout.write(JSON.stringify({report, digest, raws, priorScores, repairedRoots:selector.rootsForCase(dataset,repaired.id)}));
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
    const provider = createProvider({out:${JSON.stringify(path.join(c.directory, "argument-probe"))}, repoRoot:${JSON.stringify(c.copy)}, version:'test', expectedRuntime:{...${JSON.stringify(c.plan.provider_runtime)},version:'test'}, env:{PATH:'/usr/bin:/bin'}, verifyPolicy:()=>{},
      resolveExecutable:()=>${JSON.stringify(c.plan.provider_runtime.executable)},
      execVersion:()=> 'test',
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

test("score-only reuses recorded reviewer prompt identity after a live prompt edit", async (context) => {
  const c = await cachedCampaign(context);
  const planBytes = readFileSync(path.join(c.out, "plan.json"), "utf8");
  const prompt = path.join(c.copy, "scripts/review/prompts/v2/request.md");
  writeFileSync(
    prompt,
    `${readFileSync(prompt, "utf8")}\nRevised reviewer instructions.\n`,
  );
  assert.throws(
    () => c.runner.reviewerPrompt(c.plan, "diff"),
    /review prompt changed since plan/,
  );
  const runFailure = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {runCampaign} = await import(${JSON.stringify(c.moduleUrl("review-eval-v2-runner.mjs"))});
       try { await runCampaign({out:${JSON.stringify(c.out)}}); }
       catch (error) { process.stdout.write(error.message); }`,
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(runFailure, "review prompt changed since plan");
  const result = freshRescore(c);
  assert.equal(result.report.status, "completed");
  assert.equal(result.report.completed_cells, c.plan.cells.length);
  assert.ok(
    result.report.rows.every((row) => row.raw_reused && row.score_reused),
  );
  assert.deepEqual(result.raws, c.rawDigests);
  assert.equal(result.digest, c.scoreDigest);
  assert.equal(readFileSync(path.join(c.out, "plan.json"), "utf8"), planBytes);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);
});

test("score-only reuses historical raw execution while current callback changes invalidate grades", async (context) => {
  const c = await cachedCampaign(context);
  const planFile = path.join(c.out, "plan.json");
  const planBytes = readFileSync(planFile, "utf8");
  const target = path.join(c.copy, "scripts/review/review-eval-v2-runner.mjs");
  const before = readFileSync(target, "utf8");
  const after = before.replace(
    "export function sourceState(cwd) {",
    'export function sourceState(cwd) { if (cwd === "revision-control") return "changed-source-callback";',
  );
  assert.notEqual(after, before);
  writeFileSync(target, after);
  const changedRunner = await import(
    `${c.moduleUrl("review-eval-v2-runner.mjs")}?changed`
  );
  assert.equal(
    changedRunner.sourceState("revision-control"),
    "changed-source-callback",
  );
  await assert.rejects(
    changedRunner.runCampaign({ out: c.out }),
    /execution source changed since plan/,
  );
  const grading = await import(c.moduleUrl("review-eval-v2-grading.mjs"));
  await assert.rejects(
    grading.gradeCell({}),
    /scoring source changed after module load/,
    "direct grading must reject stale callbacks before inspecting artifacts",
  );
  const result = freshRescore(c);
  assert.equal(result.report.status, "completed");
  assert.deepEqual(result.raws, c.rawDigests);
  assert.notEqual(result.digest, c.scoreDigest);
  assert.ok(
    result.priorScores.every((present) => !present),
    "old grades cannot survive changed source callbacks",
  );
  assert.ok(
    result.report.rows.every((row) => row.raw_reused && row.score_reused),
  );
  assert.equal(readFileSync(planFile, "utf8"), planBytes);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);

  // Missing raw must stop before materialization or any reviewer invocation.
  for (const file of readdirSync(path.join(c.out, "cache/raw"))) {
    rmSync(path.join(c.out, "cache/raw", file));
  }
  const missing = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const {runCampaign} = await import(${JSON.stringify(c.moduleUrl("review-eval-v2-runner.mjs"))});
    process.stdout.write(JSON.stringify(await runCampaign({out:${JSON.stringify(c.out)},scoreOnly:true})));
  `,
      ],
      { encoding: "utf8", env: process.env },
    ),
  );
  assert.equal(missing.status, "incomplete");
  assert.match(missing.failure, /no compatible raw result/);
  assert.equal(existsSync(path.join(c.out, "fixtures")), false);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);
});

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

test("same-version runtime changes reject reviewer resume but allow current-runtime rescoring of saved raw", async (context) => {
  for (const legacy of [false, true]) {
    await context.test(
      legacy ? "historical unpinned raw" : "pinned raw",
      async (child) => {
        const c = await cachedCampaign(
          child,
          () => "No findings.",
          undefined,
          legacy,
        );
        const planBytes = readFileSync(path.join(c.out, "plan.json"), "utf8");
        const original = path.join(c.directory, "bin/claude");
        const changedBin = path.join(c.directory, "new-bin");
        mkdirSync(changedBin);
        writeFileSync(
          path.join(changedBin, "claude"),
          readFileSync(original, "utf8") +
            "# different same-version installation\n",
          { mode: 0o755 },
        );
        process.env.PATH = changedBin;
        const observed = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        const runner=await import(${JSON.stringify(c.moduleUrl("review-eval-v2-runner.mjs"))});
        try { const report=await runner.runCampaign({out:${JSON.stringify(c.out)}}); process.stdout.write(JSON.stringify(report)); }
        catch(error) { process.stdout.write(JSON.stringify({failure:error.message})); }
      `,
          ],
          { encoding: "utf8", env: process.env },
        );
        assert.match(
          JSON.parse(observed).failure,
          legacy
            ? /plan lacks a provider runtime pin/
            : /provider executable changed/,
        );
        const result = freshRescore(c);
        assert.equal(result.report.status, "completed");
        assert.equal(result.report.completed_cells, c.plan.cells.length);
        assert.deepEqual(result.raws, c.rawDigests);
        assert.ok(
          result.priorScores.every((present) => !present),
          "current grader runtime gets a separate score identity",
        );
        assert.ok(
          result.report.rows.every((row) => row.raw_reused && row.score_reused),
        );
        assert.equal(
          readFileSync(path.join(c.out, "plan.json"), "utf8"),
          planBytes,
        );
        assert.equal(existsSync(path.join(c.out, "spend.json")), false);
        if (legacy) {
          const rawId = c.runner.executionIdentity({
            plan: c.plan,
            fixture: c.dataset.cases[0],
            treatment: "incumbent",
          });
          assert.equal(
            Object.hasOwn(rawId, "provider_runtime"),
            false,
            "old raw key shape must remain exact",
          );
        }
      },
    );
  }
});

test("CLI dispatch drift cannot turn score-only missing evidence into a reviewer call", async (context) => {
  let marker;
  const c = await cachedCampaign(
    context,
    undefined,
    undefined,
    false,
    ({ copy, directory }) => {
      // Isolate this dispatch proof from fixture materialization and providers.
      // These instrumented bytes are already present when the real planner pins them.
      marker = path.join(directory, "reviewer-invoked");
      const source = path.join(directory, "stub-source");
      mkdirSync(source);
      const runner = path.join(
        copy,
        "scripts/review/review-eval-v2-runner.mjs",
      );
      let body = readFileSync(runner, "utf8");
      for (const [before, after] of [
        [
          "import { loadDataset, verifyCaseProbes }",
          "import { loadDataset, verifyCaseProbes as unusedProbe }",
        ],
        [
          "export function sourceState(cwd) {",
          'export function sourceState(cwd) { return "unused-cached-source";',
        ],
        [
          "function sourceDiff(cwd) {",
          'function sourceDiff(cwd) { return "controlled diff";',
        ],
        [
          "function prepareCase({ fixture, dataset, datasetFile, out }) {",
          `function prepareCase({ fixture, dataset, datasetFile, out }) { return {path:${JSON.stringify(source)}};`,
        ],
      ]) {
        assert.ok(body.includes(before));
        body = body.replace(before, after);
      }
      writeFileSync(runner, body + "\nconst verifyCaseProbes = () => {};\n");
      const provider = path.join(
        copy,
        "scripts/review/review-eval-v2-provider.mjs",
      );
      const original = readFileSync(provider, "utf8");
      assert.ok(original.includes("export function createProvider("));
      writeFileSync(
        provider,
        original.replace(
          "export function createProvider(",
          "function unusedCreateProvider(",
        ) +
          `
      export function createProvider(options) {
        return {identity:options.expectedRuntime,ledger:{calls:[],limit_usd:null},assertRuntime(){},
          async invoke(request){writeFileSync(${JSON.stringify(marker)},request.label);throw new Error('OFFLINE_REVIEWER_SENTINEL');}};
      }
    `,
      );
    },
  );
  const cli = realpathSync(
    path.join(c.copy, "scripts/review/review-eval-v2.mjs"),
  );
  const rawDir = path.join(c.out, "cache/raw");
  const saved = path.join(c.directory, "saved-raw");
  cpSync(rawDir, saved, { recursive: true });
  rmSync(rawDir, { recursive: true });
  const invoke = () =>
    spawnSync(process.execPath, [cli, "score", "--out", c.out], {
      encoding: "utf8",
      env: process.env,
    });
  const control = invoke();
  assert.equal(control.status, 1);
  assert.match(control.stdout, /no compatible raw result/);
  assert.equal(existsSync(marker), false);
  const original = readFileSync(cli, "utf8");
  assert.ok(original.includes('scoreOnly: mode === "score"'));
  writeFileSync(
    cli,
    original.replace('scoreOnly: mode === "score"', "scoreOnly: false"),
  );
  const drifted = invoke();
  assert.equal(drifted.status, 1);
  assert.equal(
    existsSync(marker),
    false,
    "changed dispatch must not reach the reviewer transport",
  );
  assert.match(drifted.stderr, /execution source changed since plan/);
  assert.equal(existsSync(path.join(c.out, "spend.json")), false);
  // Valid score-only dispatch still reuses historical raw identities after a CLI edit.
  writeFileSync(
    cli,
    original +
      "\n// Revised CLI documentation, unchanged score-only dispatch.\n",
  );
  cpSync(saved, rawDir, { recursive: true });
  const rescored = freshRescore(c);
  assert.equal(rescored.report.status, "completed");
  assert.deepEqual(rescored.raws, c.rawDigests);
  const completed = invoke();
  assert.equal(completed.status, 0, completed.stderr);
  const report = JSON.parse(completed.stdout);
  assert.equal(report.status, "completed");
  assert.ok(report.rows.every((row) => row.raw_reused && row.score_reused));
  assert.equal(existsSync(marker), false);
});

test("planning rejects loaded execution drift before and during version capture", async (context) => {
  for (const duringProbe of [false, true])
    await context.test(String(duringProbe), async (child) => {
      const c = await cachedCampaign(child);
      const target = path.join(
        c.copy,
        "scripts/review/review-eval-v2-dataset.mjs",
      );
      const out = path.join(c.directory, "next-plan");
      const changed =
        readFileSync(target, "utf8") + "\n// changed during planning\n";
      if (duringProbe) {
        const shim = c.plan.provider_runtime.executable;
        writeFileSync(
          shim,
          `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(target)},${JSON.stringify(changed)}); process.stdout.write('claude-test-version\\n');\n`,
          { mode: 0o755 },
        );
      } else writeFileSync(target, changed);
      assert.throws(
        () =>
          c.runner.makePlan({
            datasetFile: c.plan.dataset_file,
            incumbent: c.plan.skills.incumbent.skill_ref,
            candidate: c.plan.skills.candidate.skill_ref,
            out,
          }),
        /execution source changed after module load/,
      );
      assert.equal(existsSync(path.join(out, "plan.json")), false);
    });
});

test("recorded and legacy raw survive a changed execution identity builder", async (context) => {
  for (const legacy of [false, true])
    await context.test(String(legacy), async (child) => {
      const c = await cachedCampaign(child);
      if (legacy) {
        const planFile = path.join(c.out, "plan.json");
        const stored = JSON.parse(readFileSync(planFile, "utf8"));
        delete stored.plan_digest;
        for (const cell of stored.cells) delete cell.raw_identity;
        const { digestObject } = await import(
          c.moduleUrl("review-eval-experiment-contract.mjs")
        );
        writeFileSync(
          planFile,
          JSON.stringify({ ...stored, plan_digest: digestObject(stored) }),
        );
      }
      const target = path.join(
        c.copy,
        "scripts/review/review-eval-v2-runner.mjs",
      );
      const before = readFileSync(target, "utf8");
      const signature =
        "export function executionIdentity({ plan, fixture, treatment }) {";
      assert.ok(before.includes(signature));
      const after = before.replace(
        signature,
        signature +
          ` const {digest: previousDigest, ...inputs} = historicalIdentity({plan,fixture,treatment}); return keyed({...inputs, revised_reviewer_input:true}); }\nfunction historicalIdentity({plan,fixture,treatment}) {`,
      );
      writeFileSync(target, after);
      const revisedRunner = await import(
        `${c.moduleUrl("review-eval-v2-runner.mjs")}?valid-shape`
      );
      const { digestObject } = await import(
        c.moduleUrl("review-eval-experiment-contract.mjs")
      );
      const cell = c.plan.cells[0];
      const revised = revisedRunner.executionIdentity({
        plan: c.plan,
        fixture: c.dataset.cases.find((item) => item.id === cell.case_id),
        treatment: cell.treatment,
      });
      const { digest, ...inputs } = revised;
      assert.equal(
        digest,
        digestObject(inputs),
        "mutated identity must have a valid content digest",
      );
      assert.equal(inputs.revised_reviewer_input, true);
      assert.notEqual(digest, c.rawIdentities[0].digest);
      const result = freshRescore(c);
      assert.equal(result.report.status, "completed", result.report.failure);
      assert.deepEqual(result.raws, c.rawDigests);
      assert.ok(result.report.rows.every((row) => row.raw_reused));
      assert.notEqual(result.digest, c.scoreDigest);
    });
});

test("recorded raw identities reject changed source and plan pins", async (context) => {
  for (const changed of ["fixture", "identity", "version"])
    await context.test(changed, async (child) => {
      const c = await cachedCampaign(child);
      const { digestObject } = await import(
        c.moduleUrl("review-eval-experiment-contract.mjs")
      );
      if (changed === "fixture") {
        const dataset = JSON.parse(readFileSync(c.plan.dataset_file, "utf8"));
        dataset.cases[0].forbidden_shas.push("a".repeat(40));
        writeFileSync(c.plan.dataset_file, JSON.stringify(dataset));
        await assert.rejects(
          c.runner.runCampaign({ out: c.out, scoreOnly: true }),
          /unaudited forbidden commits/,
        );
        assert.equal(existsSync(path.join(c.out, "spend.json")), false);
        return;
      } else {
        const stored = JSON.parse(
          readFileSync(path.join(c.out, "plan.json"), "utf8"),
        );
        delete stored.plan_digest;
        if (changed === "version") stored.cells[0].raw_identity_version = 99;
        else {
          const identity = stored.cells[0].raw_identity;
          identity.model = "changed-model";
          delete identity.digest;
          identity.digest = digestObject(identity);
        }
        writeFileSync(
          path.join(c.out, "plan.json"),
          JSON.stringify({ ...stored, plan_digest: digestObject(stored) }),
        );
      }
      const result = await c.runner.runCampaign({
        out: c.out,
        scoreOnly: true,
      });
      assert.equal(result.status, "incomplete");
      assert.match(result.failure, /recorded raw identity/);
      assert.equal(existsSync(path.join(c.out, "spend.json")), false);
    });
});
