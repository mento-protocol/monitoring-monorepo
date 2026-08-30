# Controlled main lifecycle boundary
# ──────────────────────────────────
#
# This ruleset is separate from the existing `main` ruleset (live ID 13494367).
# GitHub aggregates every active ruleset that targets a ref. A bypass actor can
# bypass only the rules in the ruleset that names that actor. The unchanged
# core ruleset therefore keeps its PR, check, thread, linear-history, deletion,
# and force-push controls. This lifecycle ruleset independently limits who can
# create, update, or delete `main`.
#
# Do not import ruleset 13494367 into `github_repository_ruleset`. Provider
# 6.12.1 cannot represent GitHub's live
# `require_extra_approval_for_unattributed_changes` parameter. Importing and
# updating it through that resource can remove a live PR control. ADR 0080 owns
# the fail-closed adoption deferral and operator sequence.

locals {
  main_lifecycle_boundary_policy                = jsondecode(file("${path.module}/main-lifecycle-boundary-policy.json"))
  controlled_main_lifecycle_resources_enabled   = local.main_lifecycle_boundary_policy.controlled_main_lifecycle_resources_enabled
  human_merge_operator_team_slug                = local.main_lifecycle_boundary_policy.human_merge_operator_team_slug
  human_merge_operator_team_id                  = local.main_lifecycle_boundary_policy.human_merge_operator_team_id
  dependabot_merge_app_id                       = local.main_lifecycle_boundary_policy.dependabot_merge_app_id
  dependabot_merge_app_repository_permissions   = local.main_lifecycle_boundary_policy.dependabot_merge_app_repository_permissions
  local_agent_github_app_id                     = local.main_lifecycle_boundary_policy.local_agent_github_app_id
  controlled_main_lifecycle_ruleset_id          = local.main_lifecycle_boundary_policy.controlled_main_lifecycle_ruleset_id
  controlled_main_lifecycle_ruleset_enforcement = local.main_lifecycle_boundary_policy.controlled_main_lifecycle_ruleset_enforcement
  dependabot_merge_environment_enabled          = local.main_lifecycle_boundary_policy.dependabot_merge_environment_enabled
  dependabot_merge_app_credentials_enabled      = local.main_lifecycle_boundary_policy.dependabot_merge_app_credentials_enabled
  dependabot_merge_writer_migration_verified    = local.main_lifecycle_boundary_policy.dependabot_merge_writer_migration_verified
  legacy_dependabot_auto_merge_drained          = local.main_lifecycle_boundary_policy.legacy_dependabot_auto_merge_drained
}

resource "github_repository_ruleset" "controlled_main_lifecycle" {
  count = local.controlled_main_lifecycle_resources_enabled ? 1 : 0

  name        = "controlled-main-lifecycle"
  repository  = "monitoring-monorepo"
  target      = "branch"
  enforcement = local.controlled_main_lifecycle_ruleset_enforcement

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  # A human creates and populates the exact `merge-operators` Team outside the
  # repo-scoped stack. Its numeric ID stays in reviewed source. The Team can
  # bypass lifecycle rules only through pull requests.
  bypass_actors {
    actor_id    = local.human_merge_operator_team_id
    actor_type  = "Team"
    bypass_mode = "pull_request"
  }

  # This repository-scoped App is the only automation bypass. It is the direct
  # `main` lifecycle update actor for the trusted writer's one synchronous,
  # exact-head REST merge. `exempt` authorizes that direct update. The writer
  # leaves no standing auto-merge request. The shared GitHub Actions App, the
  # Dependabot App, and the local agent App are never bypass actors.
  bypass_actors {
    actor_id    = local.dependabot_merge_app_id
    actor_type  = "Integration"
    bypass_mode = "exempt"
  }

  rules {
    creation = true
    update   = true
    deletion = true
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        local.main_lifecycle_boundary_policy.repository == "mento-protocol/monitoring-monorepo" &&
        local.controlled_main_lifecycle_resources_enabled == true &&
        local.human_merge_operator_team_slug == "merge-operators" &&
        local.human_merge_operator_team_id > 0 &&
        floor(local.human_merge_operator_team_id) == local.human_merge_operator_team_id &&
        local.human_merge_operator_team_id <= 9007199254740991 &&
        local.dependabot_merge_app_id > 0 &&
        floor(local.dependabot_merge_app_id) == local.dependabot_merge_app_id &&
        local.dependabot_merge_app_id <= 9007199254740991 &&
        !contains([15368, 29110], local.dependabot_merge_app_id) &&
        length(keys(local.dependabot_merge_app_repository_permissions)) == 3 &&
        try(local.dependabot_merge_app_repository_permissions.contents, null) == "write" &&
        try(local.dependabot_merge_app_repository_permissions.pull_requests, null) == "write" &&
        try(local.dependabot_merge_app_repository_permissions.workflows, null) == "write" &&
        local.local_agent_github_app_id > 0 &&
        floor(local.local_agent_github_app_id) == local.local_agent_github_app_id &&
        local.local_agent_github_app_id <= 9007199254740991 &&
        !contains([15368, 29110], local.local_agent_github_app_id) &&
        local.dependabot_merge_app_id != local.local_agent_github_app_id &&
        local.controlled_main_lifecycle_ruleset_id >= 0 &&
        floor(local.controlled_main_lifecycle_ruleset_id) == local.controlled_main_lifecycle_ruleset_id &&
        local.controlled_main_lifecycle_ruleset_id <= 9007199254740991 &&
        local.controlled_main_lifecycle_ruleset_id != 13494367 &&
        contains(["disabled", "active"], local.controlled_main_lifecycle_ruleset_enforcement) &&
        (
          local.dependabot_merge_environment_enabled == false ||
          local.dependabot_merge_environment_enabled == true
        ) &&
        (
          local.dependabot_merge_app_credentials_enabled == false ||
          local.dependabot_merge_app_credentials_enabled == true
        ) &&
        (
          local.dependabot_merge_writer_migration_verified == false ||
          local.dependabot_merge_writer_migration_verified == true
        ) &&
        (
          local.legacy_dependabot_auto_merge_drained == false ||
          local.legacy_dependabot_auto_merge_drained == true
        ) &&
        (
          local.local_agent_github_broker_scaffold_enabled == false ||
          local.local_agent_github_broker_scaffold_enabled == true
        ) &&
        (
          local.local_agent_github_broker_partial_recovery_enabled == false ||
          local.local_agent_github_broker_partial_recovery_enabled == true
        ) &&
        (
          local.local_agent_github_broker_scaffold_enabled ?
          (
            local.controlled_main_lifecycle_ruleset_id > 0 &&
            can(regex("^serviceAccount:[^@[:space:]]+@[^@[:space:]]+\\.iam\\.gserviceaccount\\.com$", local.local_agent_github_broker_impersonator))
          ) :
          local.local_agent_github_broker_impersonator == ""
        ) &&
        (
          local.local_agent_github_broker_scaffold_enabled ||
          var.local_agent_github_app_credential_active == false
        ) &&
        (
          local.dependabot_merge_environment_enabled == false ||
          local.controlled_main_lifecycle_ruleset_id > 0
        ) &&
        (
          local.dependabot_merge_app_credentials_enabled == false ||
          (
            local.dependabot_merge_environment_enabled &&
            local.controlled_main_lifecycle_ruleset_id > 0
          )
        ) &&
        (
          local.dependabot_merge_writer_migration_verified == false ||
          (
            local.dependabot_merge_environment_enabled &&
            local.dependabot_merge_app_credentials_enabled &&
            local.controlled_main_lifecycle_ruleset_id > 0
          )
        ) &&
        (
          local.legacy_dependabot_auto_merge_drained == false ||
          local.dependabot_merge_writer_migration_verified
        ) &&
        (
          local.local_agent_github_broker_partial_recovery_enabled == false ||
          (
            local.local_agent_github_broker_scaffold_enabled &&
            local.controlled_main_lifecycle_ruleset_id > 0 &&
            local.controlled_main_lifecycle_ruleset_enforcement == "disabled" &&
            local.main_lifecycle_boundary_policy.ruleset_audit_active == false
          )
        ) &&
        (
          local.controlled_main_lifecycle_ruleset_enforcement != "active" ||
          (
            local.dependabot_merge_app_credentials_enabled &&
            local.dependabot_merge_writer_migration_verified &&
            local.legacy_dependabot_auto_merge_drained
          )
        ) &&
        (
          local.controlled_main_lifecycle_ruleset_id != 0 ||
          (
            local.controlled_main_lifecycle_ruleset_enforcement == "disabled" &&
            local.main_lifecycle_boundary_policy.ruleset_audit_active == false
          )
        ) &&
        (
          local.main_lifecycle_boundary_policy.ruleset_audit_active == false ||
          (
            local.controlled_main_lifecycle_ruleset_id > 0 &&
            local.controlled_main_lifecycle_ruleset_enforcement == "active"
          )
        )
      )
      error_message = "terraform/main-lifecycle-boundary-policy.json must enable boundary resources, pin the repository, exact merge-operators Team slug, approved Team, dedicated Dependabot merge App, and local-agent App IDs, exact Contents/write, Pull requests/write, and Workflows/write dedicated-App permissions, non-core managed lifecycle ruleset ID, valid enforcement state, ordered main-only Environment and credential gates, exact-head REST writer migration and legacy auto-merge request absence evidence, ordered audit activation, and coherent broker gates. The dedicated App ID must differ from GitHub Actions, Dependabot, and the local-agent App. Initial ruleset creation requires ID 0, disabled enforcement, an inactive audit, disabled Environment, credential, and broker gates, and no migration or drain claim."
    }
  }
}
