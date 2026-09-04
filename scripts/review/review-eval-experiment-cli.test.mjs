#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertOutsideRepository,
  inertP1Warning,
  isExperimentEntryPoint,
  parseExperimentArgs,
} from "./review-eval-experiment.mjs";
import { canonicalPath } from "./review-eval-fixtures.mjs";

test("experiment artifacts cannot enter the repository", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "review-experiment-cli-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      assertOutsideRepository(path.join(root, "artifacts"), root, "artifacts"),
    /must be outside/,
  );
  assert.equal(
    assertOutsideRepository(`${root}-outside`, root, "artifacts"),
    canonicalPath(`${root}-outside`),
  );
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  assert.throws(
    () =>
      assertOutsideRepository(
        path.join(sourceRoot, ".experiment-cache"),
        root,
        "artifacts",
      ),
    /must be outside/,
  );
  const linkRoot = mkdtempSync(
    path.join(os.tmpdir(), "review-experiment-source-link-"),
  );
  context.after(() => rmSync(linkRoot, { recursive: true, force: true }));
  const sourceLink = path.join(linkRoot, "source");
  symlinkSync(sourceRoot, sourceLink);
  assert.throws(
    () =>
      assertOutsideRepository(
        path.join(sourceLink, ".experiment-cache"),
        root,
        "fixture cache",
      ),
    /must be outside/,
  );
});

test("experiment entry detection uses an escaped file URL", () => {
  const entryPath = path.join(os.tmpdir(), "review eval #entry.mjs");
  assert.equal(
    isExperimentEntryPoint(entryPath, pathToFileURL(entryPath).href),
    true,
  );
  assert.equal(isExperimentEntryPoint(entryPath, `file://${entryPath}`), false);
});

test("experiment CLI runs from an entry path with escaped characters", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "review eval #entry-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const linkedReviewDir = path.join(root, "review");
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), linkedReviewDir);
  const result = spawnSync(
    process.execPath,
    [
      "--preserve-symlinks-main",
      path.join(linkedReviewDir, "review-eval-experiment.mjs"),
      "--help",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Usage: node scripts\/review\/review-eval-experiment\.mjs/,
  );
});

test("experiment CLI plans one named candidate", () => {
  const options = parseExperimentArgs([
    "--plan",
    "--candidate",
    "prompt-a=/tmp/prompt-a",
    "--out",
    "/tmp/campaign-a",
    "--live-paired",
  ]);
  assert.equal(options.mode, "plan");
  assert.equal(options.candidate, "prompt-a=/tmp/prompt-a");
  assert.equal(options.includeLivePaired, true);
  assert.equal(options.concurrency, 3);
  // One draw unless the operator asks for more.
  assert.equal(options.draws, 1);
  assert.equal(
    parseExperimentArgs([
      "--plan",
      "--candidate",
      "prompt-a=/tmp/prompt-a",
      "--out",
      "/tmp/campaign-a",
      "--draws",
      "4",
    ]).draws,
    4,
  );
  // Five draws is the cap, and it is accepted.
  assert.equal(
    parseExperimentArgs([
      "--plan",
      "--candidate",
      "prompt-a=/tmp/prompt-a",
      "--out",
      "/tmp/campaign-a",
      "--draws",
      "5",
    ]).draws,
    5,
  );
});

test("experiment CLI validates and runs an existing campaign", () => {
  const validate = parseExperimentArgs(["--validate-plan", "/tmp/campaign-a"]);
  assert.equal(validate.mode, "validate-plan");
  assert.equal(validate.campaignDir, "/tmp/campaign-a");

  const run = parseExperimentArgs([
    "--run",
    "/tmp/campaign-a",
    "--stage",
    "screen",
    "--dry-run",
    "--concurrency",
    "2",
  ]);
  assert.equal(run.mode, "run");
  assert.equal(run.stage, "screen");
  assert.equal(run.dryRun, true);
  assert.equal(run.concurrency, 2);
});

test("planning warns once when the grid freezes no P1 defect", () => {
  const withP1 = { policy: { opportunities: { p1_opportunities: 22 } } };
  assert.equal(inertP1Warning(withP1), null);
  const inert = inertP1Warning({
    policy: { opportunities: { p1_opportunities: 0 } },
  });
  assert.match(inert, /no P1 defect/);
  assert.match(inert, /every P1 threshold is zero/);
});

for (const [name, argv, message] of [
  ["one mode", [], /choose exactly one/],
  ["exclusive modes", ["--plan", "--run", "/tmp/run"], /choose exactly one/],
  ["candidate", ["--plan", "--out", "/tmp/run"], /requires --candidate/],
  ["output", ["--plan", "--candidate", "a=/tmp/a"], /requires --out/],
  ["stage", ["--run", "/tmp/run"], /requires --stage/],
  [
    "known stage",
    ["--run", "/tmp/run", "--stage", "unknown"],
    /--stage must be/,
  ],
  [
    "positive concurrency",
    ["--run", "/tmp/run", "--stage", "screen", "--concurrency", "0"],
    /positive integer/,
  ],
  [
    "draws scope",
    ["--run", "/tmp/run", "--stage", "screen", "--draws", "2"],
    /--draws is valid only with --plan/,
  ],
  [
    "positive draws",
    ["--plan", "--candidate", "a=/tmp/a", "--out", "/tmp/run", "--draws", "0"],
    /--draws must be an integer 1\.\.5/,
  ],
  [
    // Every draw multiplies the paid cells, so the cap is an error and not a
    // clamp: a campaign that asked for six is not silently priced at five.
    "draws over the cap",
    ["--plan", "--candidate", "a=/tmp/a", "--out", "/tmp/run", "--draws", "6"],
    /--draws must be an integer 1\.\.5/,
  ],
  [
    "dry-run scope",
    ["--plan", "--candidate", "a=/tmp/a", "--out", "/tmp/run", "--dry-run"],
    /valid only with --run/,
  ],
]) {
  test(`experiment CLI rejects invalid ${name}`, () => {
    assert.throws(() => parseExperimentArgs(argv), message);
  });
}
