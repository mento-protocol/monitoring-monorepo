# Dedicated Dependabot merge App credentials for the workflow_run writer
# ───────────────────────────────────────────────────────────────────────
#
# The trusted writer runs from the default branch through `workflow_run`. It
# reads repository Actions secrets. The operator encrypts both values with the
# repository Actions public key before Terraform sees them. Terraform and its
# state receive ciphertext only. The triggering Dependabot pull request never
# receives either value.

resource "github_actions_secret" "dependabot_merge_app_id" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_app_credentials_enabled ? 1 : 0

  repository      = "monitoring-monorepo"
  secret_name     = "DEPENDABOT_MERGE_APP_ID"
  key_id          = var.dependabot_merge_app_actions_public_key_id
  value_encrypted = var.dependabot_merge_app_id_encrypted_value

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.dependabot_merge_app_id > 0 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        can(regex("^[A-Za-z0-9_-]{1,256}$", var.dependabot_merge_app_actions_public_key_id)) &&
        length(var.dependabot_merge_app_id_encrypted_value) > 0 &&
        length(var.dependabot_merge_app_id_encrypted_value) <= 131072 &&
        length(var.dependabot_merge_app_id_encrypted_value) % 4 == 0 &&
        can(regex("^[A-Za-z0-9+/]+={0,2}$", var.dependabot_merge_app_id_encrypted_value))
      )
      error_message = "The enabled Dependabot merge App ID secret requires source-pinned dedicated App identity and one bounded base64 ciphertext encrypted to the repository Actions public key."
    }
  }
}

resource "github_actions_secret" "dependabot_merge_app_private_key" {
  count = local.controlled_main_lifecycle_resources_enabled && local.dependabot_merge_app_credentials_enabled ? 1 : 0

  repository      = "monitoring-monorepo"
  secret_name     = "DEPENDABOT_MERGE_APP_PRIVATE_KEY"
  key_id          = var.dependabot_merge_app_actions_public_key_id
  value_encrypted = var.dependabot_merge_app_private_key_encrypted_value

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.dependabot_merge_app_id > 0 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        can(regex("^[A-Za-z0-9_-]{1,256}$", var.dependabot_merge_app_actions_public_key_id)) &&
        length(var.dependabot_merge_app_private_key_encrypted_value) > 0 &&
        length(var.dependabot_merge_app_private_key_encrypted_value) <= 131072 &&
        length(var.dependabot_merge_app_private_key_encrypted_value) % 4 == 0 &&
        can(regex("^[A-Za-z0-9+/]+={0,2}$", var.dependabot_merge_app_private_key_encrypted_value))
      )
      error_message = "The enabled Dependabot merge App key secret requires one bounded base64 ciphertext encrypted to the repository Actions public key. Plaintext key material must never enter Terraform."
    }
  }
}
