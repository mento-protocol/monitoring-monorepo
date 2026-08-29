# Human-only main lifecycle boundary
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
# updating it through that resource can remove a live PR control. ADR 0078 owns
# the fail-closed adoption deferral and operator sequence.

locals {
  human_merge_boundary_policy              = jsondecode(file("${path.module}/human-merge-boundary-policy.json"))
  human_merge_operator_team_id             = local.human_merge_boundary_policy.human_merge_operator_team_id
  human_main_lifecycle_ruleset_id          = local.human_merge_boundary_policy.human_main_lifecycle_ruleset_id
  human_main_lifecycle_ruleset_enforcement = local.human_merge_boundary_policy.human_main_lifecycle_ruleset_enforcement
}

resource "github_repository_ruleset" "human_only_main_lifecycle" {
  name        = "human-only-main-lifecycle"
  repository  = "monitoring-monorepo"
  target      = "branch"
  enforcement = local.human_main_lifecycle_ruleset_enforcement

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  # A human creates and populates this team outside the repo-scoped stack. Its
  # numeric ID stays in reviewed source. The checked-in zero sentinel keeps
  # every plan fail-closed until a human supplies the approved ID. The agent
  # GitHub App must never be added here.
  bypass_actors {
    actor_id    = local.human_merge_operator_team_id
    actor_type  = "Team"
    bypass_mode = "pull_request"
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
        local.human_merge_boundary_policy.repository == "mento-protocol/monitoring-monorepo" &&
        local.human_merge_operator_team_id > 0 &&
        floor(local.human_merge_operator_team_id) == local.human_merge_operator_team_id &&
        local.human_merge_operator_team_id <= 9007199254740991 &&
        local.human_main_lifecycle_ruleset_id >= 0 &&
        floor(local.human_main_lifecycle_ruleset_id) == local.human_main_lifecycle_ruleset_id &&
        local.human_main_lifecycle_ruleset_id <= 9007199254740991 &&
        local.human_main_lifecycle_ruleset_id != 13494367 &&
        contains(["disabled", "active"], local.human_main_lifecycle_ruleset_enforcement) &&
        (
          local.human_main_lifecycle_ruleset_id != 0 ||
          (
            local.human_main_lifecycle_ruleset_enforcement == "disabled" &&
            local.human_merge_boundary_policy.ruleset_audit_active == false
          )
        ) &&
        (
          local.human_merge_boundary_policy.ruleset_audit_active == false ||
          (
            local.human_main_lifecycle_ruleset_id > 0 &&
            local.human_main_lifecycle_ruleset_enforcement == "active"
          )
        )
      )
      error_message = "terraform/human-merge-boundary-policy.json must pin the repository, approved Team ID, non-core managed lifecycle ruleset ID, valid enforcement state, and ordered audit activation. Initial creation requires ID 0, disabled enforcement, and an inactive audit."
    }
  }
}
