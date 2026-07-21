#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkTerraformFormat } from "./terraform-fmt-check.mjs";

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
}

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function readCalls(logPath) {
  const contents = readFileSync(logPath, "utf8").trim();
  return contents
    ? contents.split(/\r?\n/u).map((line) => JSON.parse(line))
    : [];
}

function expectFailure(callback, pattern) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert(caught, "expected Terraform format check to fail");
  assert.match(caught.message, pattern);
  return caught;
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "terraform-fmt-check-test-"));
try {
  const moduleRoot = path.join(tempRoot, "stack");
  const binRoot = path.join(tempRoot, "bin");
  const terraformLog = path.join(tempRoot, "terraform.log");
  const fakeTerraform = path.join(binRoot, "terraform");
  const failingGit = path.join(binRoot, "git-fail");
  mkdirSync(moduleRoot);
  mkdirSync(binRoot);

  writeFileSync(
    path.join(moduleRoot, ".gitignore"),
    "terraform.tfvars\n*.auto.tfvars\n",
  );
  writeFileSync(path.join(moduleRoot, "main.tf"), 'variable "name" {}\n');
  writeFileSync(path.join(moduleRoot, "deleted.tf"), 'variable "old" {}\n');

  runGit(tempRoot, ["init", "-q"]);
  runGit(tempRoot, ["config", "user.email", "test@example.invalid"]);
  runGit(tempRoot, ["config", "user.name", "Terraform Format Test"]);
  runGit(tempRoot, ["add", "."]);
  runGit(tempRoot, ["commit", "-qm", "fixtures"]);
  unlinkSync(path.join(moduleRoot, "deleted.tf"));

  writeFileSync(
    path.join(moduleRoot, "terraform.tfvars"),
    'synthetic_value="ignored"\n',
  );
  writeFileSync(
    path.join(moduleRoot, "local.auto.tfvars"),
    'synthetic_value="also ignored"\n',
  );
  const newlinePath = "line\nbreak.tf";
  writeFileSync(path.join(moduleRoot, newlinePath), 'variable "newline" {}\n');

  writeExecutable(
    fakeTerraform,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.TERRAFORM_FMT_TEST_LOG, JSON.stringify(args) + "\\n");
if (args.some((arg) => arg.endsWith("/unformatted.tf"))) process.exit(9);
`,
  );
  writeExecutable(failingGit, "#!/bin/sh\nexit 42\n");

  const env = {
    ...process.env,
    TERRAFORM_FMT_TEST_LOG: terraformLog,
  };
  const targets = checkTerraformFormat("stack", {
    env,
    repoRoot: tempRoot,
    terraformBinary: fakeTerraform,
  });
  assert(targets.includes("./main.tf"), "tracked Terraform source was omitted");
  assert(
    targets.includes(`./${newlinePath}`),
    "NUL-delimited untracked Terraform path was not preserved",
  );
  assert(
    !targets.includes("./deleted.tf"),
    "deleted tracked path was included",
  );
  assert(
    !targets.includes("./terraform.tfvars"),
    "ignored operator tfvars was included",
  );
  assert(
    !targets.includes("./local.auto.tfvars"),
    "ignored auto tfvars was included",
  );

  let calls = readCalls(terraformLog);
  assert.equal(calls.length, targets.length);
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    targets,
    "Terraform targets were not checked one at a time in deterministic order",
  );
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 3), [
      `-chdir=${realpathSync(moduleRoot)}`,
      "fmt",
      "-check",
    ]);
    assert.equal(args.length, 4, "Terraform received more than one target");
    assert(
      !args.some((arg) => arg.includes("terraform.tfvars")),
      "ignored operator tfvars reached Terraform",
    );
    assert(
      !args.some((arg) => arg.includes("local.auto.tfvars")),
      "ignored auto tfvars reached Terraform",
    );
  }
  assert(calls.some((args) => args.at(-1) === `./${newlinePath}`));

  writeFileSync(
    path.join(moduleRoot, "unformatted.tf"),
    'variable "unformatted" {}\n',
  );
  writeFileSync(
    path.join(moduleRoot, "zz-after-failure.tf"),
    'variable "after_failure" {}\n',
  );
  const callsBeforeFailure = calls.length;
  const terraformFailure = expectFailure(
    () =>
      checkTerraformFormat("stack", {
        env,
        repoRoot: tempRoot,
        terraformBinary: fakeTerraform,
      }),
    /terraform fmt -check failed with exit code 9/u,
  );
  assert.equal(terraformFailure.exitCode, 9);
  unlinkSync(path.join(moduleRoot, "unformatted.tf"));
  unlinkSync(path.join(moduleRoot, "zz-after-failure.tf"));

  calls = readCalls(terraformLog);
  const failureCalls = calls.slice(callsBeforeFailure);
  assert.deepEqual(
    failureCalls.map((args) => args.at(-1)),
    [...targets, "./unformatted.tf"],
    "Terraform did not stop deterministically at the first failing target",
  );
  assert(
    !failureCalls.some((args) => args.at(-1) === "./zz-after-failure.tf"),
    "Terraform continued after a target failed",
  );
  const callsAfterTerraformFailure = calls.length;
  expectFailure(
    () =>
      checkTerraformFormat("stack", {
        env,
        gitBinary: failingGit,
        repoRoot: tempRoot,
        terraformBinary: fakeTerraform,
      }),
    /git ls-files failed with exit code 42/u,
  );
  assert.equal(
    readCalls(terraformLog).length,
    callsAfterTerraformFailure,
    "Terraform ran after Git enumeration failed",
  );

  const outsideFile = path.join(tempRoot, "outside.tf");
  writeFileSync(outsideFile, 'variable "outside" {}\n');
  symlinkSync(outsideFile, path.join(moduleRoot, "linked.tf"));
  expectFailure(
    () =>
      checkTerraformFormat("stack", {
        env,
        repoRoot: tempRoot,
        terraformBinary: fakeTerraform,
      }),
    /Terraform format target must be a regular file: linked\.tf/u,
  );
  assert.equal(
    readCalls(terraformLog).length,
    callsAfterTerraformFailure,
    "Terraform ran after a symlink target was discovered",
  );
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}

console.log("terraform fmt check tests passed");
