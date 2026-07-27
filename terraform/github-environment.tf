# GitHub Environment that gates the Sentry triage/autofix pipeline secrets.
#
# THREAT (issue #1289). Repo-level GitHub Actions secrets are readable by ANY
# workflow run in the repo, including a run of a BRANCH-MODIFIED workflow file
# triggered via `workflow_dispatch` on a feature branch. The in-workflow
# `if: github.ref == 'refs/heads/main'` job guards are evaluated FROM the
# dispatched ref, so a repository writer can push a branch that deletes the
# guard and exfiltrate every repo-level secret the workflow names. The guard is
# a convention, not a security boundary.
#
# WHAT THIS ACTUALLY DOES (corrected 2026-07-27 — see issue #1649). The intent
# was that a deployment-branch policy limited to the protected branch (main)
# would make secret access SERVER-ENFORCED regardless of the branch's workflow
# file. THAT IS NOT WHAT GITHUB DOES. Deployment-branch policies constrain
# `push`/`pull_request`/`deployment` events by ref, but they DO NOT gate
# `workflow_dispatch`: a dispatch run — which any user with `write` can trigger
# on any ref — receives the environment's secrets whether or not the ref
# satisfies the policy. Verified empirically with both an admin and a non-admin
# `write` collaborator dispatching a guard-stripped branch; both got the secret.
#
# So this environment provides SCOPING (only jobs that declare it see these
# secrets, instead of every workflow run in the repo), not the branch boundary
# #1289 intended. The in-workflow `if: github.ref == 'refs/heads/main'` guards do
# not close the gap either: the environment-declaring jobs in
# sentry-triage-agent.yml and sentry-autofix.yml carry NO such guard (so the
# triage token and the autofix App key are reachable off-main with nothing in the
# way), and even where a guard exists it cannot bind an attacker, who controls
# the whole workflow file on their branch and can declare this environment from
# any job they write. Real fixes (separate repo / short-lived OIDC-minted
# credentials / dropping `workflow_dispatch`) are tracked in #1649.
# This mirrors the `production-infra` environment that already gates Terraform
# applies — but this one carries NO required reviewers (the pipeline is
# unattended; a reviewer gate would stall every scheduled run) and NO wait timer.
#
# SCOPE. Only the Sentry-pipeline-EXCLUSIVE secrets move here. The shared
# CLAUDE_CODE_OAUTH_TOKEN stays a repo-level secret (github-secrets.tf) because
# `.github/workflows/claude.yml` consumes it on `pull_request` events from
# feature branches — precisely the surface a main-only environment denies — so a
# main-only environment is fundamentally incompatible with that consumer. Its
# blast radius is inference-quota abuse only (it holds no repo/data write
# capability of its own), an accepted residual; the Sentry jobs that declare this
# environment still stop leaking it off-main as a side effect. See the runbook in
# docs/notes/sentry-triage-pipeline.md.
#
# ROLLOUT ORDER (docs/terraform.md "GitHub Environments"): a new `environment:`
# workflow reference AUTO-CREATES an unprotected Environment if the protected one
# does not already exist. Therefore this environment + its secrets MUST be
# applied BEFORE the workflow `environment:` references reach `main`. See the
# migration plan: apply this file's resources first (repo-level secrets in
# github-secrets.tf stay in place for that apply), then land the workflow
# references and the repo-level secret removals.

resource "github_repository_environment" "sentry_pipeline" {
  repository  = "monitoring-monorepo"
  environment = "sentry-pipeline"

  # Deployment-branch policy limited to PROTECTED branches. `main` is the repo's
  # only protected branch, so this restricts every environment consumer to main
  # — the same shape `scripts/verify-github-environment-protection.mjs` asserts
  # for `production-infra` (protected_branches = true, custom_branch_policies =
  # false). No `reviewers {}` block and no `wait_timer`: the pipeline runs
  # unattended, so a human-approval gate would stall every scheduled run.
  #
  # `can_admins_bypass = false` (#1635) is INERT for this environment — kept only
  # because it is the strictest value and costs nothing. It governs the reviewer
  # / wait-timer PROTECTION RULES (the ones that park a deployment in a "Pending"
  # state for an admin to override); this environment declares neither, so the
  # flag has nothing to act on. It does NOT restrict the deployment-branch
  # policy: verified 2026-07-27 with the flag already `false`, an admin
  # `workflow_dispatch` from a non-main branch still read the environment secret
  # — as did a NON-ADMIN `write` collaborator, because branch policies do not
  # gate `workflow_dispatch` at all (see the header note and #1649).
  #
  # Do not read this flag as a security control. The real fixes are in #1649.
  can_admins_bypass = false

  deployment_branch_policy {
    protected_branches     = true
    custom_branch_policies = false
  }
}

# The five Sentry-pipeline-EXCLUSIVE secrets, moved from `github_actions_secret`
# (repo scope) in github-secrets.tf to `github_actions_environment_secret`
# (environment scope). Each stays `count`-gated on the SAME tfvar exactly as its
# former repo-level resource was, so `terraform apply` still succeeds while the
# value is unset and the pipeline stays inert until the operator provisions it.
# `value` (not the deprecated `plaintext_value`) matches the repo-level secrets'
# attribute on the `integrations/github ~> 6.12` provider. `environment` is wired
# to the resource above so Terraform creates the Environment before its secrets.

# SENTRY_TRIAGE_TOKEN — read-only Sentry token (Issue/Event, Project, Org read).
# Consumed by the ingest job and the triage select/triage jobs, all of which now
# declare `environment: sentry-pipeline`.
resource "github_actions_environment_secret" "sentry_triage_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off as the
  # repo-level mirrors; see the threat-model note in github-secrets.tf.
  count = var.sentry_triage_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.sentry_pipeline.environment
  secret_name = "SENTRY_TRIAGE_TOKEN"
  value       = var.sentry_triage_token
}

# SENTRY_PROJECTION_TOKEN — fine-grained GitHub PAT (Issues R/W on the three
# owning repos only). Consumed by the serialized `project` job in
# sentry-triage-agent.yml, which now declares `environment: sentry-pipeline`.
# The job's existing inline `github.ref == 'refs/heads/main'` gate on this secret
# becomes a redundant belt-and-suspenders once the environment enforces main.
resource "github_actions_environment_secret" "sentry_projection_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off; see
  # github-secrets.tf.
  count = var.sentry_projection_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.sentry_pipeline.environment
  secret_name = "SENTRY_PROJECTION_TOKEN"
  value       = var.sentry_projection_token
}

# AUTOFIX_APP_PRIVATE_KEY — PEM private key of the `sentry-autofix` GitHub App.
# Consumed as a presence guard by the autofix `select` job and to mint the App
# installation token by the autofix `finalize` job; both now declare
# `environment: sentry-pipeline`. This is the highest-value secret in the set (it
# mints Contents:R/W + Pull-requests:R/W tokens), which is why the header note
# matters most here: environment scoping is NOT a branch boundary, so this key
# is still reachable by any writer via `workflow_dispatch` (#1649).
resource "github_actions_environment_secret" "autofix_app_private_key" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off; see
  # github-secrets.tf.
  count = var.autofix_app_private_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.sentry_pipeline.environment
  secret_name = "AUTOFIX_APP_PRIVATE_KEY"
  value       = var.autofix_app_private_key
}

# SENTRY_ARCHIVE_TOKEN — write-scoped Sentry token (Issue/Event R+W only).
# Consumed only by the `archive` job in sentry-triage-archive.yml, which now
# declares `environment: sentry-pipeline`.
resource "github_actions_environment_secret" "sentry_archive_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off; see
  # github-secrets.tf.
  count = var.sentry_archive_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.sentry_pipeline.environment
  secret_name = "SENTRY_ARCHIVE_TOKEN"
  value       = var.sentry_archive_token
}

# PLATFORM_SETTINGS_AUDIT_TOKEN — fine-grained GitHub PAT (Administration: Read
# on this repo only). Consumed only by the `check` job in
# platform-settings-drift.yml, which now declares `environment: sentry-pipeline`.
resource "github_actions_environment_secret" "platform_settings_audit_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off; see
  # github-secrets.tf.
  count = var.platform_settings_audit_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.sentry_pipeline.environment
  secret_name = "PLATFORM_SETTINGS_AUDIT_TOKEN"
  value       = var.platform_settings_audit_token
}
