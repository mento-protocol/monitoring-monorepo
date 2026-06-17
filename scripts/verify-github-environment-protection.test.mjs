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
  deployment_branch_policy: {
    protected_branches: true,
    custom_branch_policies: false,
  },
};

assert.deepEqual(environmentProtectionFailures(protectedEnvironment), []);

assert.deepEqual(
  environmentProtectionFailures({
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  }),
  ["required reviewers are not configured"],
);

assert.deepEqual(
  environmentProtectionFailures({
    can_admins_bypass: true,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: "approver" } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  }),
  [
    "admin bypass is not disabled",
    "self-review is not allowed for required reviewers",
    "deployment branches are not limited to protected branches",
  ],
);

assert.deepEqual(
  environmentProtectionFailures({
    can_admins_bypass: false,
    protection_rules: [
      {
        type: "required_reviewers",
        reviewers: [{ type: "User", reviewer: { login: "approver" } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  }),
  ["self-review is not allowed for required reviewers"],
);

assert.deepEqual(
  environmentProtectionFailures({
    protection_rules: protectedEnvironment.protection_rules,
    deployment_branch_policy: protectedEnvironment.deployment_branch_policy,
  }),
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
