#!/usr/bin/env node
// Focused coverage for the credential predicates check-pr-validation-boundary
// builds its closed authority inventory from. Carried over from the retired
// check-autofix-ci-trust suite (issue #2486), minus the autofix-specific guard
// and annotation cases that went with the checker. Every case here is a
// fail-OPEN a reviewer would not see: a job that really can hold a credential
// but reads as clean.
import assert from "node:assert/strict";
import test from "node:test";

import {
  collectTriggers,
  grantsOidc,
  hasWritePermission,
  jobPersistsWriteCheckout,
  jobReceivesCredential,
  parseWorkflow,
} from "./workflow-credentials.mjs";

const NONE = { envSecrets: false, workflowPermissions: undefined };

test("parseWorkflow returns null for sources it cannot analyze", () => {
  assert.equal(parseWorkflow("on: push\njobs: {}\n").on, "push");
  assert.equal(parseWorkflow("a:\n\tb: 1\n"), null, "tab indentation");
  assert.equal(parseWorkflow("a: 1\n---\nb: 2\n"), null, "multi-document");
  assert.equal(parseWorkflow("a: [1\n"), null, "syntax error");
});

test("collectTriggers normalizes every legal on: shape", () => {
  const triggers = (body) => [...collectTriggers(parseWorkflow(body))].sort();
  assert.deepEqual(triggers("on: pull_request\n"), ["pull_request"]);
  assert.deepEqual(triggers("on: [push, pull_request]\n"), [
    "pull_request",
    "push",
  ]);
  assert.deepEqual(triggers("on:\n  pull_request:\n    branches: [main]\n"), [
    "pull_request",
  ]);
  // A flow/JSON document root and an anchor both resolve before this sees them.
  assert.deepEqual(triggers('{"on": {"workflow_run": {}}}\n'), [
    "workflow_run",
  ]);
  assert.deepEqual(triggers("x: &a\n  push: null\non: *a\n"), ["push"]);
  assert.deepEqual(triggers("jobs: {}\n"), []);
});

test("grantsOidc and hasWritePermission read both permission forms", () => {
  assert.equal(grantsOidc("write-all"), true);
  assert.equal(grantsOidc({ "id-token": "write" }), true);
  assert.equal(grantsOidc({ "id-token": "read", contents: "write" }), false);
  assert.equal(grantsOidc("read-all"), false);
  assert.equal(hasWritePermission("write-all"), true);
  assert.equal(hasWritePermission({ issues: "write" }), true);
  assert.equal(hasWritePermission({ contents: "read" }), false);
  assert.equal(hasWritePermission(undefined), false);
});

test("a secrets reference counts however it is spelled or nested", () => {
  const step = (value) => ({ steps: [{ run: "x", env: { TOKEN: value } }] });
  assert.equal(
    jobReceivesCredential(step("${{ secrets.X }}"), NONE),
    true,
    "a plain reference",
  );
  assert.equal(
    jobReceivesCredential(step("${{ SECRETS.X }}"), NONE),
    true,
    "GitHub resolves the context case-insensitively",
  );
  assert.equal(
    jobReceivesCredential(step("${{ fromJSON('{}') || secrets.X }}"), NONE),
    true,
    "braces inside the expression do not end the scan",
  );
  assert.equal(jobReceivesCredential(step("plain"), NONE), false);
  // Inherited from a workflow-level env:, which reaches every job and step.
  assert.equal(
    jobReceivesCredential(step("plain"), {
      envSecrets: true,
      workflowPermissions: undefined,
    }),
    true,
  );
});

test("a job's own permissions replace the workflow grant, not merge with it", () => {
  const job = { steps: [] };
  assert.equal(
    jobReceivesCredential(job, {
      envSecrets: false,
      workflowPermissions: { "id-token": "write" },
    }),
    true,
    "OIDC is inherited when the job declares no permissions",
  );
  assert.equal(
    jobReceivesCredential(
      { ...job, permissions: { contents: "read" } },
      { envSecrets: false, workflowPermissions: { "id-token": "write" } },
    ),
    false,
    "a job that narrows the grant loses the inherited OIDC",
  );
});

test("a write-scoped automatic token is a credential in either spelling", () => {
  const job = {
    permissions: { issues: "write" },
    steps: [
      { run: "gh issue create", env: { GH_TOKEN: "${{ github.token }}" } },
    ],
  };
  assert.equal(jobReceivesCredential(job, NONE), true);
  assert.equal(
    jobReceivesCredential({ ...job, permissions: { issues: "read" } }, NONE),
    false,
    "the same reference without a write scope is not a mutating credential",
  );
  assert.equal(
    jobReceivesCredential(
      { permissions: { issues: "write" }, steps: [{ run: "gh issue create" }] },
      {
        envSecrets: false,
        envWorkflowToken: true,
        workflowPermissions: undefined,
      },
    ),
    true,
    "the reference may be inherited from a workflow-level env:",
  );
});

test("a write-permission checkout leaves a token on disk unless it opts out", () => {
  const write = { issues: "write" };
  const job = (step) => ({ permissions: write, steps: [step] });
  const checkout = { uses: "actions/checkout@v4" };
  assert.equal(jobPersistsWriteCheckout(job(checkout), write), true);
  assert.equal(
    jobPersistsWriteCheckout(
      job({ ...checkout, with: { "persist-credentials": false } }),
      write,
    ),
    false,
  );
  assert.equal(
    jobPersistsWriteCheckout(
      job({ ...checkout, with: { "persist-credentials": "FALSE" } }),
      write,
    ),
    false,
    "checkout's own getBooleanInput accepts any casing of false",
  );
  assert.equal(
    jobPersistsWriteCheckout(
      job({ ...checkout, with: { "persist-credentials": "${{ inputs.x }}" } }),
      write,
    ),
    true,
    "an unevaluable value is not an opt-out",
  );
  assert.equal(
    jobPersistsWriteCheckout(job({ uses: " actions/checkout@v4" }), write),
    true,
    "a quoted scalar keeps its leading space; trimming keeps this fail-closed",
  );
  assert.equal(
    jobPersistsWriteCheckout(
      job({ uses: "actions/checkout-lookalike@v1" }),
      write,
    ),
    false,
    "a lookalike action is not actions/checkout",
  );
  assert.equal(
    jobPersistsWriteCheckout(
      {
        permissions: write,
        steps: [
          { ...checkout, with: { "persist-credentials": false } },
          checkout,
        ],
      },
      write,
    ),
    true,
    "one opted-out checkout does not undo a sibling that persists",
  );
  assert.equal(
    jobPersistsWriteCheckout(job(checkout), { contents: "read" }),
    false,
    "a read-only job's checkout token cannot mutate the repo",
  );
});

test("a forwarded secret, an environment, or an in-repo callee counts", () => {
  assert.equal(
    jobReceivesCredential({ uses: "./x.yml", secrets: "inherit" }, NONE),
    true,
  );
  assert.equal(
    jobReceivesCredential({ steps: [], environment: "production-infra" }, NONE),
    true,
  );
  for (const uses of [
    "./.github/workflows/reusable.yml",
    "$/.github/workflows/reusable.yml",
    "mento-protocol/monitoring-monorepo/.github/workflows/reusable.yml@main",
    "MENTO-PROTOCOL/Monitoring-Monorepo/.github/workflows/reusable.yml@main",
  ]) {
    assert.equal(
      jobReceivesCredential({ uses }, NONE),
      true,
      `an in-repo reusable call may bind a credential this pass cannot see: ${uses}`,
    );
  }
  assert.equal(
    jobReceivesCredential(
      { uses: "other-org/other-repo/.github/workflows/x.yml@v1" },
      NONE,
    ),
    false,
    "another repo's reusable workflow receives secrets only via an explicit secrets: key",
  );
  assert.equal(jobReceivesCredential({ steps: [] }, NONE), false);
  assert.equal(jobReceivesCredential(null, NONE), false);
});
