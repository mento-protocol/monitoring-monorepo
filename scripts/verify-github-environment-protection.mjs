#!/usr/bin/env node

const DEFAULT_ENVIRONMENT = "production-infra";
const DEFAULT_API_URL = "https://api.github.com";

// `branchPolicies` is the `branch_policies` array from
// GET /repos/:o/:r/environments/:env/deployment-branch-policies.
//
// Why this function needs it (issue #1649): the previous version asserted
// `protected_branches === true`, which restricts deployments to branches under
// CLASSIC branch protection. This repo protects `main` with a ruleset and has
// no classic protection, so that policy matched nothing and FAILED OPEN — the
// configuration read as correct here while off-main runs could reach the
// environment's secrets. Asserting the configured shape was not enough; the
// allow-list itself has to be checked, so an empty or over-broad pattern set
// cannot pass.
export function environmentProtectionFailures(environment, branchPolicies) {
  const rules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules
    : [];
  const reviewers = rules.find((rule) => rule.type === "required_reviewers");
  const branchPolicy = environment.deployment_branch_policy;
  const failures = [];

  if (environment.can_admins_bypass !== false) {
    failures.push("admin bypass is not disabled");
  }
  if (!reviewers || (reviewers.reviewers ?? []).length === 0) {
    failures.push("required reviewers are not configured");
  }
  if (reviewers && reviewers.prevent_self_review !== false) {
    failures.push("self-review is not allowed for required reviewers");
  }
  if (
    branchPolicy?.custom_branch_policies !== true ||
    branchPolicy?.protected_branches !== false
  ) {
    failures.push(
      "deployment branches are not limited by an explicit branch pattern",
    );
  } else {
    // Fail closed: an unreadable or empty allow-list is a failure, never a pass.
    const patterns = Array.isArray(branchPolicies)
      ? branchPolicies.map((policy) => policy?.name)
      : null;
    if (patterns === null) {
      failures.push("deployment branch policies could not be read");
    } else if (patterns.length === 0) {
      failures.push("no deployment branch pattern is configured");
    } else if (patterns.some((name) => name !== "main")) {
      failures.push(
        `deployment branch patterns must be exactly ["main"], found ${JSON.stringify(patterns)}`,
      );
    }
  }

  return failures;
}

export function environmentUrl(apiUrl, repository, environmentName) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repo form");
  }

  const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  return new URL(
    `repos/${owner}/${repo}/environments/${encodeURIComponent(environmentName)}`,
    base,
  );
}

async function fetchEnvironment({
  apiUrl,
  repository,
  environmentName,
  token,
}) {
  const response = await fetch(
    environmentUrl(apiUrl, repository, environmentName),
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub environment lookup failed with HTTP ${response.status}`,
    );
  }

  return response.json();
}

async function fetchBranchPolicies({
  apiUrl,
  repository,
  environmentName,
  token,
}) {
  const url = new URL(
    "deployment-branch-policies",
    `${environmentUrl(apiUrl, repository, environmentName)}/`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub deployment-branch-policy lookup failed with HTTP ${response.status}`,
    );
  }

  const body = await response.json();
  return body?.branch_policies ?? [];
}

async function main(env = process.env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const environmentName = env.GITHUB_ENVIRONMENT_NAME || DEFAULT_ENVIRONMENT;
  const apiUrl = env.GITHUB_API_URL || DEFAULT_API_URL;
  const environment = await fetchEnvironment({
    apiUrl,
    repository,
    environmentName,
    token,
  });
  // Read the allow-list too — the configured shape alone does not prove the
  // branch restriction is effective (#1649). A throw here fails the gate.
  const branchPolicies = await fetchBranchPolicies({
    apiUrl,
    repository,
    environmentName,
    token,
  });
  const failures = environmentProtectionFailures(environment, branchPolicies);

  if (failures.length > 0) {
    throw new Error(
      `${environmentName} environment is not apply-safe: ${failures.join("; ")}`,
    );
  }

  console.log(`${environmentName} environment protection verified`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
