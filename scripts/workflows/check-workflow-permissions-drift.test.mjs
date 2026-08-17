#!/usr/bin/env node
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPECTED,
  evaluateWorkflowPermissions,
  runCli,
} from "./check-workflow-permissions-drift.mjs";

// ── evaluateWorkflowPermissions ──────────────────────────────────────────────

test("read + no-approve is the pinned invariant → ok", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });
  assert.equal(v.status, "ok");
  assert.deepEqual(v.violations, []);
});

test("write default → drift naming default_workflow_permissions", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: false,
  });
  assert.equal(v.status, "drift");
  assert.equal(v.violations.length, 1);
  assert.match(v.violations[0], /default_workflow_permissions is "write"/);
});

test("token PR-approval enabled → drift naming can_approve", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: true,
  });
  assert.equal(v.status, "drift");
  assert.equal(v.violations.length, 1);
  assert.match(v.violations[0], /can_approve_pull_request_reviews is true/);
});

test("both reverted → two violations", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: true,
  });
  assert.equal(v.status, "drift");
  assert.equal(v.violations.length, 2);
});

test("unknown permission enum → malformed, never ok/drift", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "none",
    can_approve_pull_request_reviews: false,
  });
  assert.equal(v.status, "malformed");
});

test("missing default_workflow_permissions → malformed (fail closed)", () => {
  const v = evaluateWorkflowPermissions({
    can_approve_pull_request_reviews: false,
  });
  assert.equal(v.status, "malformed");
});

test("non-boolean can_approve → malformed (fail closed)", () => {
  const v = evaluateWorkflowPermissions({
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: null,
  });
  assert.equal(v.status, "malformed");
});

test("non-object responses are malformed, not ok", () => {
  for (const bad of [null, [], 42, "read", undefined]) {
    const v = evaluateWorkflowPermissions(bad);
    assert.equal(v.status, "malformed", `input ${JSON.stringify(bad)}`);
  }
});

// ── runCli (exit codes + rendering) ──────────────────────────────────────────

function capture(raw) {
  let out = "";
  const code = runCli(raw, { stdout: { write: (s) => (out += s) } });
  return { code, out };
}

test("runCli: ok input exits 0", () => {
  const { code, out } = capture(
    JSON.stringify({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    }),
  );
  assert.equal(code, 0);
  assert.match(out, /^OK:/);
});

test("runCli: drift input exits 2 and lists each violation", () => {
  const { code, out } = capture(
    JSON.stringify({
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
    }),
  );
  assert.equal(code, 2);
  assert.match(out, /^DRIFT:/);
  assert.match(out, /default_workflow_permissions is "write"/);
  assert.match(out, /can_approve_pull_request_reviews is true/);
});

test("runCli: malformed shape exits 3", () => {
  const { code, out } = capture(
    JSON.stringify({ default_workflow_permissions: "none" }),
  );
  assert.equal(code, 3);
  assert.match(out, /^MALFORMED:/);
});

test("runCli: invalid JSON exits 3 (never silently ok)", () => {
  const { code, out } = capture("not json {");
  assert.equal(code, 3);
  assert.match(out, /^MALFORMED:/);
});

test("EXPECTED invariant is frozen", () => {
  assert.equal(EXPECTED.default_workflow_permissions, "read");
  assert.equal(EXPECTED.can_approve_pull_request_reviews, false);
  assert.ok(Object.isFrozen(EXPECTED));
});
