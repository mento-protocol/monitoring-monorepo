#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  environmentProtectionFailures,
  environmentUrl,
} from "./verify-github-environment-protection.mjs";

const protectedEnvironment = {
  can_admins_bypass: false,
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { login: "approver" } }],
    },
  ],
  // The shape that actually restricts deployments in this repo (#1649):
  // `protected_branches` keys off CLASSIC branch protection, which this repo
  // does not use, so it fails open.
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
};

const mainOnly = [{ name: "main" }];

assert.deepEqual(
  environmentProtectionFailures(protectedEnvironment, mainOnly),
  [],
);

// The OLD shape must now FAIL — this is the regression that hid #1649.
assert.deepEqual(
  environmentProtectionFailures(
    {
      ...protectedEnvironment,
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    },
    mainOnly,
  ),
  ["deployment branches are not limited by an explicit branch pattern"],
);

// Fail closed on an unreadable, empty, or over-broad allow-list.
assert.deepEqual(environmentProtectionFailures(protectedEnvironment, null), [
  "deployment branch policies could not be read",
]);
assert.deepEqual(environmentProtectionFailures(protectedEnvironment, []), [
  "no deployment branch pattern is configured",
]);
assert.deepEqual(
  environmentProtectionFailures(protectedEnvironment, [
    { name: "main" },
    { name: "release/*" },
  ]),
  [
    'deployment branch patterns must be exactly ["main"], found ["main","release/*"]',
  ],
);

assert.deepEqual(
  environmentProtectionFailures(
    {
      can_admins_bypass: false,
      protection_rules: [],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    mainOnly,
  ),
  ["required reviewers are not configured"],
);

assert.deepEqual(
  environmentProtectionFailures(
    {
      can_admins_bypass: true,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "User", reviewer: { login: "approver" } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    },
    mainOnly,
  ),
  [
    "admin bypass is not disabled",
    "self-review is not allowed for required reviewers",
    "deployment branches are not limited by an explicit branch pattern",
  ],
);

assert.deepEqual(
  environmentProtectionFailures(
    {
      can_admins_bypass: false,
      protection_rules: [
        {
          type: "required_reviewers",
          reviewers: [{ type: "User", reviewer: { login: "approver" } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    mainOnly,
  ),
  ["self-review is not allowed for required reviewers"],
);

assert.deepEqual(
  environmentProtectionFailures(
    {
      protection_rules: protectedEnvironment.protection_rules,
      deployment_branch_policy: protectedEnvironment.deployment_branch_policy,
    },
    mainOnly,
  ),
  ["admin bypass is not disabled"],
);

assert.equal(
  environmentUrl(
    "https://api.github.test",
    "mento-protocol/monitoring-monorepo",
    "production infra",
  ).toString(),
  "https://api.github.test/repos/mento-protocol/monitoring-monorepo/environments/production%20infra",
);

console.log("verify-github-environment-protection tests passed");
