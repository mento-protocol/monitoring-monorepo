import {
  GITHUB_OIDC_ISSUER,
  PRODUCTION_PROVIDER_VARIABLE,
  PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
  PRODUCTION_SUBJECT,
  REFRESH_SERVICE_ACCOUNT_VARIABLE,
  SEED_PROJECT_ID,
} from "./production-infra-identity-contract-constants.mjs";
import {
  attributeExpression,
  blockKey,
  expectExpression,
  expectMapEntry,
  expectString,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  parseHclString,
  requireBlock,
  sameSortedValues,
  stringAttribute,
} from "./production-infra-identity-contract-hcl.mjs";

export function validateProvider(
  blocks,
  { poolName, poolId, providerName, providerCondition, conditionLabel },
  errors,
) {
  const filePath = "terraform/ci-wif.tf";
  const pool = requireBlock(
    blocks,
    filePath,
    "google_iam_workload_identity_pool",
    poolName,
    errors,
    conditionLabel,
  );
  const provider = requireBlock(
    blocks,
    filePath,
    "google_iam_workload_identity_pool_provider",
    providerName,
    errors,
    conditionLabel,
  );

  if (pool) {
    expectExpression(
      pool,
      "project",
      "google_project.monitoring.project_id",
      errors,
      conditionLabel,
    );
    expectString(
      pool,
      "workload_identity_pool_id",
      poolId,
      errors,
      conditionLabel,
    );
  }

  if (provider) {
    expectExpression(
      provider,
      "project",
      "google_project.monitoring.project_id",
      errors,
      conditionLabel,
    );
    expectExpression(
      provider,
      "workload_identity_pool_id",
      `google_iam_workload_identity_pool.${poolName}.workload_identity_pool_id`,
      errors,
      conditionLabel,
    );
    expectString(
      provider,
      "workload_identity_pool_provider_id",
      "github",
      errors,
      conditionLabel,
    );
    const actualCondition = stringAttribute(provider, "attribute_condition");
    if (
      normalizeExpression(actualCondition) !==
      normalizeExpression(providerCondition)
    ) {
      errors.push(
        `${conditionLabel}: attribute_condition must be the exact non-bypassable condition`,
      );
    }
    expectMapEntry(
      provider,
      "google.subject",
      "assertion.sub",
      errors,
      conditionLabel,
    );
    expectMapEntry(
      provider,
      "attribute.repository",
      "assertion.repository",
      errors,
      conditionLabel,
    );
    expectMapEntry(
      provider,
      "attribute.ref",
      "assertion.ref",
      errors,
      conditionLabel,
    );

    const oidcBlocks = nestedBlocks(provider, "oidc");
    if (oidcBlocks.length !== 1) {
      errors.push(
        `${conditionLabel}: provider must contain exactly one oidc block`,
      );
    } else {
      expectString(
        oidcBlocks[0],
        "issuer_uri",
        GITHUB_OIDC_ISSUER,
        errors,
        `${conditionLabel}: oidc`,
      );
    }
  }

  const poolsWithId = blocks.filter(
    (block) =>
      block.type === "google_iam_workload_identity_pool" &&
      stringAttribute(block, "workload_identity_pool_id") === poolId,
  );
  if (poolsWithId.length !== 1) {
    errors.push(
      `${conditionLabel}: exactly one ${poolId} workload identity pool is allowed`,
    );
  }

  const providersForPool = blocks.filter((block) => {
    if (block.type !== "google_iam_workload_identity_pool_provider") {
      return false;
    }
    const expression = attributeExpression(block, "workload_identity_pool_id");
    return (
      normalizeExpression(expression) ===
        `google_iam_workload_identity_pool.${poolName}.workload_identity_pool_id` ||
      parseHclString(expression) === poolId
    );
  });
  if (
    providersForPool.length !== 1 ||
    providersForPool[0]?.name !== providerName
  ) {
    errors.push(
      `${conditionLabel}: exactly one provider in the ${poolId} pool is allowed`,
    );
  }
}

export function validateGithubVariables(blocks, errors) {
  const specifications = [
    {
      name: "gcp_production_infra_workload_identity_provider",
      variable: PRODUCTION_PROVIDER_VARIABLE,
      value:
        "google_iam_workload_identity_pool_provider.github_production_infra.name",
      dependencies: [
        "google_service_account_iam_member.production_infra_applier_wif_binding",
        "google_service_account_iam_member.production_infra_applier_org_terraform_token_creator",
      ],
    },
    {
      name: "gcp_production_infra_service_account",
      variable: PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
      value: "google_service_account.production_infra_applier.email",
      dependencies: [
        "google_service_account_iam_member.production_infra_applier_wif_binding",
        "google_service_account_iam_member.production_infra_applier_org_terraform_token_creator",
      ],
    },
    {
      name: "gcp_terraform_refresh_service_account",
      variable: REFRESH_SERVICE_ACCOUNT_VARIABLE,
      value: "google_service_account.terraform_refresh_readonly.email",
      dependencies: [
        "google_service_account_iam_member.terraform_refresh_readonly_wif_binding",
        "google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
        "google_storage_bucket_iam_member.state_bucket_refresh_readonly",
      ],
    },
  ];

  for (const specification of specifications) {
    const label = `terraform: GitHub variable ${specification.variable}`;
    const block = requireBlock(
      blocks,
      "terraform/github-variables.tf",
      "github_actions_variable",
      specification.name,
      errors,
      label,
    );
    if (!block) continue;
    expectString(block, "repository", "monitoring-monorepo", errors, label);
    expectString(block, "variable_name", specification.variable, errors, label);
    expectExpression(block, "value", specification.value, errors, label);
    if (
      !sameSortedValues(
        extractExpressionList(block, "depends_on"),
        specification.dependencies,
      )
    ) {
      errors.push(
        `${label}: depends_on must contain the exact bootstrap IAM chain`,
      );
    }
  }
}

export function iamBlocks(blocks) {
  return blocks.filter((block) =>
    /_iam_(?:member|binding|policy)$/u.test(block.type),
  );
}

export function referencesProductionApplier(block) {
  return (
    block.code.includes("google_service_account.production_infra_applier.") ||
    block.code.includes("production-infra-applier@") ||
    block.code.includes("production-infra-applier")
  );
}

export function referencesRefreshWif(block) {
  return (
    block.code.includes("google_service_account.terraform_refresh_readonly.") ||
    block.code.includes("serviceAccount:terraform-refresh-readonly@")
  );
}

export function referencesRefreshTarget(block) {
  return (
    block.code.includes(
      "google_service_account.org_terraform_refresh_readonly.",
    ) || block.code.includes("org-terraform-refresh-readonly@")
  );
}

export function rejectUnexpectedIdentityGrants(
  blocks,
  predicate,
  allowedKeys,
  errors,
  label,
) {
  const unexpected = iamBlocks(blocks)
    .filter(predicate)
    .map(blockKey)
    .filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    errors.push(
      `${label}: unexpected IAM grants are forbidden: ${unexpected.sort().join(", ")}`,
    );
  }
}

export function validateProductionIdentity(blocks, errors) {
  const serviceAccount = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account",
    "production_infra_applier",
    errors,
    "terraform: production applier",
  );
  if (serviceAccount) {
    expectString(
      serviceAccount,
      "project",
      SEED_PROJECT_ID,
      errors,
      "terraform: production applier",
    );
    expectString(
      serviceAccount,
      "account_id",
      "production-infra-applier",
      errors,
      "terraform: production applier",
    );
  }

  const wifBinding = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "production_infra_applier_wif_binding",
    errors,
    "terraform: production applier WIF binding",
  );
  if (wifBinding) {
    expectExpression(
      wifBinding,
      "service_account_id",
      "google_service_account.production_infra_applier.name",
      errors,
      "terraform: production applier WIF binding",
    );
    expectString(
      wifBinding,
      "role",
      "roles/iam.workloadIdentityUser",
      errors,
      "terraform: production applier WIF binding",
    );
    expectString(
      wifBinding,
      "member",
      `principal://iam.googleapis.com/\${google_iam_workload_identity_pool.github_production_infra.name}/subject/${PRODUCTION_SUBJECT}`,
      errors,
      "terraform: production applier WIF binding",
    );
  }

  const tokenCreator = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "production_infra_applier_org_terraform_token_creator",
    errors,
    "terraform: production applier token creator",
  );
  if (tokenCreator) {
    expectString(
      tokenCreator,
      "service_account_id",
      `projects/${SEED_PROJECT_ID}/serviceAccounts/\${var.terraform_service_account}`,
      errors,
      "terraform: production applier token creator",
    );
    expectString(
      tokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      "terraform: production applier token creator",
    );
    expectString(
      tokenCreator,
      "member",
      "serviceAccount:${google_service_account.production_infra_applier.email}",
      errors,
      "terraform: production applier token creator",
    );
  }

  rejectUnexpectedIdentityGrants(
    blocks,
    referencesProductionApplier,
    new Set([wifBinding, tokenCreator].filter(Boolean).map(blockKey)),
    errors,
    "terraform: production applier",
  );
}
