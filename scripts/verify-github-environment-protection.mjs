#!/usr/bin/env node

const DEFAULT_ENVIRONMENT = "production-infra";
const DEFAULT_API_URL = "https://api.github.com";

export function environmentProtectionFailures(environment) {
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
  if (reviewers?.prevent_self_review !== true) {
    failures.push("prevent self-review is not enabled");
  }
  if (
    branchPolicy?.protected_branches !== true ||
    branchPolicy?.custom_branch_policies !== false
  ) {
    failures.push("deployment branches are not limited to protected branches");
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

async function main(env = process.env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const environmentName = env.GITHUB_ENVIRONMENT_NAME || DEFAULT_ENVIRONMENT;
  const environment = await fetchEnvironment({
    apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
    repository,
    environmentName,
    token,
  });
  const failures = environmentProtectionFailures(environment);

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
