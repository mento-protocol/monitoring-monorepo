import {
  GITHUB_OIDC_ISSUER,
  PRODUCTION_PROVIDER_VARIABLE,
  PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
  PRODUCTION_SUBJECT,
  REFRESH_PROVIDER_VARIABLE,
  REFRESH_SERVICE_ACCOUNT_VARIABLE,
  SEED_PROJECT_ID,
} from "./production-infra-identity-contract-constants.mjs";
import {
  attributeExpression,
  blockKey,
  commentMaskedHcl,
  escapeRegExp,
  expectExpression,
  expectExactStringMap,
  expectNoResourceMultiplicity,
  expectString,
  extractExpressionList,
  nestedBlocks,
  normalizeExpression,
  parseHclString,
  requireBlock,
  sameSortedValues,
  stringAttribute,
  topLevelBlockKey,
} from "./production-infra-identity-contract-hcl.mjs";

const EXPECTED_PROVIDER_BLOCKS = new Set([
  "terraform/ci-wif.tf:google_iam_workload_identity_pool_provider.github",
  "terraform/ci-wif.tf:google_iam_workload_identity_pool_provider.github_production_infra",
  "terraform/ci-wif.tf:google_iam_workload_identity_pool_provider.github_terraform_refresh",
]);

const IDENTITY_REFERENCE_SPECIFICATIONS = [
  {
    label: "terraform: production applier",
    terraformName: "production_infra_applier",
    accountId: "production-infra-applier",
    allowedBlocks: new Set([
      "terraform/ci-wif.tf:resource.google_service_account.production_infra_applier",
      "terraform/ci-wif.tf:resource.google_service_account_iam_member.production_infra_applier_wif_binding",
      "terraform/ci-wif.tf:resource.google_service_account_iam_member.production_infra_applier_org_terraform_token_creator",
      "terraform/github-variables.tf:resource.github_actions_variable.gcp_production_infra_service_account",
      "terraform/outputs.tf:output.ci_production_infra_applier_email",
    ]),
  },
  {
    label: "terraform: refresh WIF identity",
    terraformName: "terraform_refresh_readonly",
    accountId: "terraform-refresh-readonly",
    allowedBlocks: new Set([
      "terraform/ci-wif.tf:resource.google_service_account.terraform_refresh_readonly",
      "terraform/ci-wif.tf:resource.google_service_account_iam_member.terraform_refresh_readonly_wif_binding",
      "terraform/ci-wif.tf:resource.google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
      "terraform/github-variables.tf:resource.github_actions_variable.gcp_terraform_refresh_service_account",
      "terraform/outputs.tf:output.ci_terraform_refresh_readonly_email",
    ]),
  },
  {
    label: "terraform: refresh target",
    terraformName: "org_terraform_refresh_readonly",
    accountId: "org-terraform-refresh-readonly",
    allowedBlocks: new Set([
      "terraform/ci-wif.tf:resource.google_service_account.org_terraform_refresh_readonly",
      "terraform/ci-wif.tf:resource.google_storage_bucket_iam_member.state_bucket_refresh_readonly",
      "terraform/ci-wif.tf:resource.google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
      "alerts/infra/main.tf:resource.google_project_iam_member.terraform_refresh_readonly",
      "alerts/infra/onchain-event-handler/main.tf:resource.google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "alerts/infra/onchain-event-handler/main.tf:resource.google_secret_manager_secret_iam_member.terraform_refresh_readonly",
      "alerts/infra/oncall-announcer/main.tf:resource.google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "alerts/infra/oncall-announcer/main.tf:resource.google_secret_manager_secret_iam_member.terraform_refresh_readonly",
      "governance-watchdog/infra/main.tf:resource.google_project_iam_member.terraform_refresh_readonly",
      "governance-watchdog/infra/storage.tf:resource.google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "governance-watchdog/infra/terraform-refresh.tf:resource.google_secret_manager_secret_iam_member.terraform_refresh_readonly",
    ]),
  },
];

export function validateProviderInventory(blocks, errors) {
  const actual = blocks
    .filter(
      (block) => block.type === "google_iam_workload_identity_pool_provider",
    )
    .map(blockKey);
  if (!sameSortedValues(actual, [...EXPECTED_PROVIDER_BLOCKS])) {
    errors.push(
      "terraform: workload identity provider inventory must contain exactly the generic, production, and refresh providers in terraform/ci-wif.tf",
    );
  }
}

function decodeTerraformUnicodeEscapes(contents) {
  const characters = contents.split("");
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== "\\") continue;
    let runEnd = index;
    while (contents[runEnd] === "\\") runEnd += 1;
    const slashCount = runEnd - index;
    if (slashCount % 2 === 0) {
      index = runEnd - 1;
      continue;
    }
    const marker = contents[runEnd];
    const digitCount = marker === "u" ? 4 : marker === "U" ? 8 : 0;
    const digits = contents.slice(runEnd + 1, runEnd + 1 + digitCount);
    if (
      digitCount === 0 ||
      digits.length !== digitCount ||
      !/^[0-9A-Fa-f]+$/u.test(digits)
    ) {
      index = runEnd - 1;
      continue;
    }
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) continue;
    const decoded = String.fromCodePoint(codePoint);
    const escapeStart = runEnd - 1;
    const escapeEnd = runEnd + 1 + digitCount;
    for (let cursor = escapeStart; cursor < escapeEnd; cursor += 1) {
      characters[cursor] = decoded[cursor - escapeStart] ?? "\0";
    }
    index = escapeEnd - 1;
  }
  return characters.join("");
}

function identityReferenceIndices(contents, terraformName, accountId) {
  const searchContents = decodeTerraformUnicodeEscapes(contents);
  const accountPattern = [...accountId]
    .map((character) => `${escapeRegExp(character)}\\x00*`)
    .join("");
  const patterns = [
    new RegExp(
      `\\bgoogle_service_account\\s*\\.\\s*${escapeRegExp(terraformName)}\\b`,
      "gu",
    ),
    new RegExp(`(?<![A-Za-z0-9-])${accountPattern}(?![A-Za-z0-9-])`, "gu"),
  ];
  return patterns.flatMap((pattern) =>
    [...searchContents.matchAll(pattern)].map((match) => match.index),
  );
}

export function validateIdentityReferenceInventory(
  files,
  topLevelBlocks,
  errors,
) {
  const blocksByFile = Map.groupBy(topLevelBlocks, (block) => block.filePath);

  for (const specification of IDENTITY_REFERENCE_SPECIFICATIONS) {
    const unexpected = new Set();
    for (const [filePath, contents] of Object.entries(files)) {
      if (!filePath.endsWith(".tf")) continue;
      const code = commentMaskedHcl(contents);
      for (const index of identityReferenceIndices(
        code,
        specification.terraformName,
        specification.accountId,
      )) {
        const containingBlock = (blocksByFile.get(filePath) ?? []).find(
          (block) => block.start <= index && index < block.end,
        );
        const key = containingBlock
          ? topLevelBlockKey(containingBlock)
          : `${filePath}:outside-top-level-block`;
        if (!specification.allowedBlocks.has(key)) unexpected.add(key);
      }
    }
    if (unexpected.size > 0) {
      errors.push(
        `${specification.label}: identity references are allowed only in explicit Terraform blocks and outputs: ${[...unexpected].sort().join(", ")}`,
      );
    }
  }
}

export function validateProvider(
  blocks,
  {
    poolName,
    poolId,
    providerName,
    providerCondition,
    conditionLabel,
    attributeMapping = {
      "google.subject": "assertion.sub",
      "attribute.repository": "assertion.repository",
      "attribute.repository_id": "assertion.repository_id",
      "attribute.ref": "assertion.ref",
    },
  },
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
    expectNoResourceMultiplicity(pool, errors, conditionLabel);
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
    expectNoResourceMultiplicity(provider, errors, conditionLabel);
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
    expectExactStringMap(
      provider,
      "attribute_mapping",
      attributeMapping,
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
      name: "gcp_terraform_refresh_workload_identity_provider",
      variable: REFRESH_PROVIDER_VARIABLE,
      value:
        "google_iam_workload_identity_pool_provider.github_terraform_refresh.name",
      dependencies: [
        "google_service_account_iam_member.terraform_refresh_readonly_wif_binding",
        "google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
        "google_storage_bucket_iam_member.state_bucket_refresh_readonly",
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
    expectNoResourceMultiplicity(block, errors, label);
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
  const legacyTokenCreator = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "ci_alerts_org_terraform_token_creator",
    errors,
    "terraform: bootstrap legacy deployer token creator",
  );
  if (legacyTokenCreator) {
    expectNoResourceMultiplicity(
      legacyTokenCreator,
      errors,
      "terraform: bootstrap legacy deployer token creator",
    );
    expectString(
      legacyTokenCreator,
      "service_account_id",
      `projects/${SEED_PROJECT_ID}/serviceAccounts/\${var.terraform_service_account}`,
      errors,
      "terraform: bootstrap legacy deployer token creator",
    );
    expectString(
      legacyTokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      "terraform: bootstrap legacy deployer token creator",
    );
    expectString(
      legacyTokenCreator,
      "member",
      "serviceAccount:${google_service_account.metrics_bridge_deployer.email}",
      errors,
      "terraform: bootstrap legacy deployer token creator",
    );
  }

  const serviceAccount = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account",
    "production_infra_applier",
    errors,
    "terraform: production applier",
  );
  if (serviceAccount) {
    expectNoResourceMultiplicity(
      serviceAccount,
      errors,
      "terraform: production applier",
    );
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
    expectNoResourceMultiplicity(
      wifBinding,
      errors,
      "terraform: production applier WIF binding",
    );
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
    expectNoResourceMultiplicity(
      tokenCreator,
      errors,
      "terraform: production applier token creator",
    );
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
