# Main-only Environment and dedicated Dependabot merge App credentials
# ────────────────────────────────────────────────────────────────────
#
# A repository Actions secret is available to a workflow_dispatch run from a
# feature ref. The dedicated App can bypass the main lifecycle ruleset, so its
# key must stay behind a server-enforced Environment branch policy. The
# Environment and its exact main-only policy are created before either secret.
# A later reviewed writer change may declare this Environment only after the
# protected resource exists live. Adding the workflow reference first would
# auto-create an unprotected Environment.

resource "github_repository_environment" "dependabot_merge" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_environment_enabled ? 1 : 0

  repository        = "monitoring-monorepo"
  environment       = "dependabot-merge"
  can_admins_bypass = false

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.dependabot_merge_app_id > 0 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        local.controlled_main_lifecycle_ruleset_id > 0
      )
      error_message = "The main-only Dependabot merge Environment requires a source-pinned dedicated App ID and managed lifecycle ruleset ID."
    }
  }
}

resource "github_repository_environment_deployment_policy" "dependabot_merge_main" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_environment_enabled ? 1 : 0

  repository     = "monitoring-monorepo"
  environment    = github_repository_environment.dependabot_merge[0].environment
  branch_pattern = "main"

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_actions_environment_secret" "dependabot_merge_app_id" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_app_credentials_enabled ? 1 : 0

  repository      = "monitoring-monorepo"
  environment     = github_repository_environment.dependabot_merge[0].environment
  secret_name     = "DEPENDABOT_MERGE_APP_ID"
  key_id          = var.dependabot_merge_app_environment_public_key_id
  value_encrypted = var.dependabot_merge_app_id_encrypted_value

  depends_on = [
    github_repository_environment_deployment_policy.dependabot_merge_main,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.dependabot_merge_app_id > 0 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        can(regex("^[A-Za-z0-9_-]{1,256}$", var.dependabot_merge_app_environment_public_key_id)) &&
        length(var.dependabot_merge_app_id_encrypted_value) > 0 &&
        length(var.dependabot_merge_app_id_encrypted_value) <= 131072 &&
        length(var.dependabot_merge_app_id_encrypted_value) % 4 == 0 &&
        can(regex("^[A-Za-z0-9+/]+={0,2}$", var.dependabot_merge_app_id_encrypted_value))
      )
      error_message = "The enabled Dependabot merge App ID secret requires source-pinned dedicated App identity and one bounded base64 ciphertext encrypted to the dependabot-merge Environment public key."
    }
  }
}

resource "github_actions_environment_secret" "dependabot_merge_app_private_key" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_app_credentials_enabled ? 1 : 0

  repository      = "monitoring-monorepo"
  environment     = github_repository_environment.dependabot_merge[0].environment
  secret_name     = "DEPENDABOT_MERGE_APP_PRIVATE_KEY"
  key_id          = var.dependabot_merge_app_environment_public_key_id
  value_encrypted = var.dependabot_merge_app_private_key_encrypted_value

  depends_on = [
    github_repository_environment_deployment_policy.dependabot_merge_main,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.dependabot_merge_app_id > 0 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        can(regex("^[A-Za-z0-9_-]{1,256}$", var.dependabot_merge_app_environment_public_key_id)) &&
        length(var.dependabot_merge_app_private_key_encrypted_value) > 0 &&
        length(var.dependabot_merge_app_private_key_encrypted_value) <= 131072 &&
        length(var.dependabot_merge_app_private_key_encrypted_value) % 4 == 0 &&
        can(regex("^[A-Za-z0-9+/]+={0,2}$", var.dependabot_merge_app_private_key_encrypted_value))
      )
      error_message = "The enabled Dependabot merge App key secret requires one bounded base64 ciphertext encrypted to the dependabot-merge Environment public key. Plaintext key material must never enter Terraform."
    }
  }
}
