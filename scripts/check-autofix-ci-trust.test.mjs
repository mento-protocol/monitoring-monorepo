#!/usr/bin/env node
import {
  evaluateWorkflow,
  hasPullRequestTrigger,
  referencesSecrets,
  usesPullRequestTarget,
} from "./check-autofix-ci-trust.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SECRET_LINE = "          token: ${{ secrets.SOME_TOKEN }}";

test("pull_request_target is always refused, even with a guard", () => {
  const body = [
    "on:",
    "  pull_request_target:",
    SECRET_LINE,
    "# sentry-autofix/ guard",
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(!v.ok && /pull_request_target/.test(v.reason), "refused");
});

test("commented-out pull_request_target does not trip the check", () => {
  const body = [
    "on:",
    "  pull_request:",
    "# never use pull_request_target here",
  ].join("\n");
  assert(!usesPullRequestTarget(body), "comment ignored");
  assert(evaluateWorkflow(body).ok, "secretless pull_request workflow is fine");
});

test("secret-bearing pull_request workflow without guard or annotation fails", () => {
  const body = ["on:", "  pull_request:", "jobs:", "  x:", SECRET_LINE].join(
    "\n",
  );
  const v = evaluateWorkflow(body);
  assert(!v.ok && /guard nor/.test(v.reason), "unguarded lane refused");
});

test("a sentry-autofix/ guard literal satisfies the check", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "guarded lane passes");
});

test("an autofix-ci-trust annotation satisfies the check", () => {
  const body = [
    "on:",
    "  pull_request:",
    "# autofix-ci-trust: secret is step-scoped to a pinned action's `with:`;",
    "# no PR-head code executes with it in env.",
    "jobs:",
    "  x:",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "annotated lane passes");
});

test("secretless pull_request workflows and non-PR workflows pass untouched", () => {
  assert(
    evaluateWorkflow(["on:", "  pull_request:", "jobs: {}"].join("\n")).ok,
    "secretless PR workflow",
  );
  assert(
    evaluateWorkflow(["on:", "  schedule:", SECRET_LINE].join("\n")).ok,
    "schedule-only workflow with secrets",
  );
});

test("trigger/secret detectors behave on edge forms", () => {
  assert(hasPullRequestTrigger("on:\n  pull_request:\n"), "block form");
  assert(hasPullRequestTrigger("on:\n  pull_request\n"), "bare key form");
  assert(!hasPullRequestTrigger("# pull_request:\n"), "comment ignored");
  assert(referencesSecrets("x: ${{ secrets.FOO }}"), "secrets expression");
  assert(!referencesSecrets("x: secrets are cool"), "prose ignored");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
