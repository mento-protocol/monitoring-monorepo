import {
  COMMON_REFRESH_PROJECT_ROLES,
  REFRESH_TARGET_EMAIL,
  SEED_PROJECT_ID,
} from "./production-infra-identity-contract-constants.mjs";
import {
  blockKey,
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  extractForEachMap,
  extractStringSet,
  requireBlock,
  requireFile,
  sameMap,
  sameSortedValues,
} from "./production-infra-identity-contract-hcl.mjs";
import {
  referencesRefreshTarget,
  referencesRefreshWif,
  rejectUnexpectedIdentityGrants,
} from "./production-infra-identity-contract-identity.mjs";

function validateProjectGrant(
  files,
  blocks,
  { filePath, resourceName, localName, project, roles, member },
  errors,
) {
  const label = `${filePath}: refresh project grants`;
  const contents = requireFile(files, filePath, errors);
  const actualRoles = extractStringSet(contents, localName);
  if (!sameSortedValues(actualRoles, roles)) {
    errors.push(
      `${label}: ${localName} must contain the exact curated role set`,
    );
  }
  const block = requireBlock(
    blocks,
    filePath,
    "google_project_iam_member",
    resourceName,
    errors,
    label,
  );
  if (block) {
    expectExpression(block, "for_each", `local.${localName}`, errors, label);
    expectExpression(block, "project", project, errors, label);
    expectExpression(block, "role", "each.value", errors, label);
    expectString(block, "member", member, errors, label);
  }
  return block;
}

function validateBucketGrant(
  blocks,
  { filePath, name, bucket, member },
  errors,
) {
  const label = `${filePath}: refresh bucket grant`;
  const block = requireBlock(
    blocks,
    filePath,
    "google_storage_bucket_iam_member",
    name,
    errors,
    label,
  );
  if (block) {
    expectNoResourceMultiplicity(block, errors, label);
    if (bucket.startsWith('"')) {
      expectString(block, "bucket", JSON.parse(bucket), errors, label);
    } else {
      expectExpression(block, "bucket", bucket, errors, label);
    }
    expectString(block, "role", "roles/storage.objectViewer", errors, label);
    expectString(block, "member", member, errors, label);
  }
  return block;
}

function validateSecretGrant(blocks, { filePath, project, secrets }, errors) {
  const label = `${filePath}: refresh secret grants`;
  const block = requireBlock(
    blocks,
    filePath,
    "google_secret_manager_secret_iam_member",
    "terraform_refresh_readonly",
    errors,
    label,
  );
  if (block) {
    if (!sameMap(extractForEachMap(block), secrets)) {
      errors.push(`${label}: for_each must contain the exact secret set`);
    }
    expectExpression(block, "project", project, errors, label);
    expectExpression(block, "secret_id", "each.value", errors, label);
    expectString(
      block,
      "role",
      "roles/secretmanager.secretAccessor",
      errors,
      label,
    );
    expectString(
      block,
      "member",
      `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      errors,
      label,
    );
  }
  return block;
}

export function validateRefreshIdentity(files, blocks, errors) {
  const refreshWif = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account",
    "terraform_refresh_readonly",
    errors,
    "terraform: refresh WIF identity",
  );
  if (refreshWif) {
    expectNoResourceMultiplicity(
      refreshWif,
      errors,
      "terraform: refresh WIF identity",
    );
    expectExpression(
      refreshWif,
      "project",
      "google_project.monitoring.project_id",
      errors,
      "terraform: refresh WIF identity",
    );
    expectString(
      refreshWif,
      "account_id",
      "terraform-refresh-readonly",
      errors,
      "terraform: refresh WIF identity",
    );
  }

  const refreshTarget = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account",
    "org_terraform_refresh_readonly",
    errors,
    "terraform: refresh target",
  );
  if (refreshTarget) {
    expectNoResourceMultiplicity(
      refreshTarget,
      errors,
      "terraform: refresh target",
    );
    expectString(
      refreshTarget,
      "project",
      SEED_PROJECT_ID,
      errors,
      "terraform: refresh target",
    );
    expectString(
      refreshTarget,
      "account_id",
      "org-terraform-refresh-readonly",
      errors,
      "terraform: refresh target",
    );
  }

  const wifBinding = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "terraform_refresh_readonly_wif_binding",
    errors,
    "terraform: refresh WIF binding",
  );
  if (wifBinding) {
    expectNoResourceMultiplicity(
      wifBinding,
      errors,
      "terraform: refresh WIF binding",
    );
    expectExpression(
      wifBinding,
      "service_account_id",
      "google_service_account.terraform_refresh_readonly.name",
      errors,
      "terraform: refresh WIF binding",
    );
    expectString(
      wifBinding,
      "role",
      "roles/iam.workloadIdentityUser",
      errors,
      "terraform: refresh WIF binding",
    );
    expectString(
      wifBinding,
      "member",
      "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.ref/refs/heads/main",
      errors,
      "terraform: refresh WIF binding",
    );
  }

  const tokenCreator = requireBlock(
    blocks,
    "terraform/ci-wif.tf",
    "google_service_account_iam_member",
    "ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
    errors,
    "terraform: refresh token creator",
  );
  if (tokenCreator) {
    expectNoResourceMultiplicity(
      tokenCreator,
      errors,
      "terraform: refresh token creator",
    );
    expectExpression(
      tokenCreator,
      "service_account_id",
      "google_service_account.org_terraform_refresh_readonly.name",
      errors,
      "terraform: refresh token creator",
    );
    expectString(
      tokenCreator,
      "role",
      "roles/iam.serviceAccountTokenCreator",
      errors,
      "terraform: refresh token creator",
    );
    expectString(
      tokenCreator,
      "member",
      "serviceAccount:${google_service_account.terraform_refresh_readonly.email}",
      errors,
      "terraform: refresh token creator",
    );
  }

  const targetMember =
    "serviceAccount:${google_service_account.org_terraform_refresh_readonly.email}";
  const expectedTargetGrants = [
    tokenCreator,
    validateBucketGrant(
      blocks,
      {
        filePath: "terraform/ci-wif.tf",
        name: "state_bucket_refresh_readonly",
        bucket: '"mento-terraform-tfstate-6ed6"',
        member: targetMember,
      },
      errors,
    ),
    validateProjectGrant(
      files,
      blocks,
      {
        filePath: "alerts/infra/main.tf",
        resourceName: "terraform_refresh_readonly",
        localName: "terraform_refresh_readonly_project_roles",
        project: "local.project_id",
        roles: COMMON_REFRESH_PROJECT_ROLES,
        member: `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      },
      errors,
    ),
    validateProjectGrant(
      files,
      blocks,
      {
        filePath: "governance-watchdog/infra/main.tf",
        resourceName: "terraform_refresh_readonly",
        localName: "terraform_refresh_readonly_project_roles",
        project: "module.governance_watchdog.project_id",
        roles: COMMON_REFRESH_PROJECT_ROLES,
        member: `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      },
      errors,
    ),
    validateBucketGrant(
      blocks,
      {
        filePath: "alerts/infra/onchain-event-handler/main.tf",
        name: "terraform_refresh_readonly_function_source",
        bucket: "google_storage_bucket.function_bucket.name",
        member: `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      },
      errors,
    ),
    validateBucketGrant(
      blocks,
      {
        filePath: "alerts/infra/oncall-announcer/main.tf",
        name: "terraform_refresh_readonly_function_source",
        bucket: "google_storage_bucket.function_bucket.name",
        member: `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      },
      errors,
    ),
    validateBucketGrant(
      blocks,
      {
        filePath: "governance-watchdog/infra/storage.tf",
        name: "terraform_refresh_readonly_function_source",
        bucket: "google_storage_bucket.watchdog_notifications_function.name",
        member: `serviceAccount:${REFRESH_TARGET_EMAIL}`,
      },
      errors,
    ),
    validateSecretGrant(
      blocks,
      {
        filePath: "alerts/infra/onchain-event-handler/main.tf",
        project: "var.project_id",
        secrets: Object.fromEntries([
          [
            "quicknode_signing",
            "google_secret_manager_secret.quicknode_signing_secret.secret_id",
          ],
          [
            "slack_bot",
            "google_secret_manager_secret.slack_bot_token.secret_id",
          ],
        ]),
      },
      errors,
    ),
    validateSecretGrant(
      blocks,
      {
        filePath: "alerts/infra/oncall-announcer/main.tf",
        project: "var.project_id",
        secrets: Object.fromEntries([
          [
            "slack_bot",
            "google_secret_manager_secret.slack_bot_token.secret_id",
          ],
          [
            "splunk_api_id",
            "google_secret_manager_secret.splunk_on_call_api_id.secret_id",
          ],
          [
            "splunk_api",
            "google_secret_manager_secret.splunk_on_call_api_key.secret_id",
          ],
        ]),
      },
      errors,
    ),
    validateSecretGrant(
      blocks,
      {
        filePath: "governance-watchdog/infra/terraform-refresh.tf",
        project: "module.governance_watchdog.project_id",
        secrets: Object.fromEntries([
          [
            "discord_test",
            "google_secret_manager_secret.discord_test_webhook_url.secret_id",
          ],
          [
            "discord_primary",
            "google_secret_manager_secret.discord_webhook_url.secret_id",
          ],
          [
            "quicknode_api",
            "google_secret_manager_secret.quicknode_api_key.secret_id",
          ],
          [
            "quicknode_security",
            "google_secret_manager_secret.quicknode_security_token.secret_id",
          ],
          [
            "telegram_bot",
            "google_secret_manager_secret.telegram_bot_token.secret_id",
          ],
          ["x_auth", "google_secret_manager_secret.x_auth_token.secret_id"],
        ]),
      },
      errors,
    ),
  ];

  rejectUnexpectedIdentityGrants(
    blocks,
    referencesRefreshWif,
    new Set([wifBinding, tokenCreator].filter(Boolean).map(blockKey)),
    errors,
    "terraform: refresh WIF identity",
  );
  rejectUnexpectedIdentityGrants(
    blocks,
    referencesRefreshTarget,
    new Set(expectedTargetGrants.filter(Boolean).map(blockKey)),
    errors,
    "terraform: refresh target",
  );
}
