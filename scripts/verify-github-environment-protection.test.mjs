#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  environmentProtectionFailures,
  environmentUrl,
} from "./verify-github-environment-protection.mjs";

const protectedEnvironment = {
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
};

assert.deepEqual(environmentProtectionFailures(protectedEnvironment), []);

assert.deepEqual(
  environmentProtectionFailures({
    protection_rules: [],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  }),
  [
    "required reviewers are not configured",
    "prevent self-review is not enabled",
  ],
);

assert.deepEqual(
  environmentProtectionFailures({
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { login: "approver" } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  }),
  [
    "prevent self-review is not enabled",
    "deployment branches are not limited to protected branches",
  ],
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
