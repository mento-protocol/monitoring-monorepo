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
# FIX. A GitHub Environment whose deployment-branch policy is limited to the
# repo's protected branch (main) makes secret access SERVER-ENFORCED: a job that
# declares `environment: sentry-pipeline` only receives the environment's
# secrets when the run's ref satisfies the branch policy, no matter what the
# branch's workflow file says. A `workflow_dispatch` from a feature branch is
# refused at the environment gate before the job starts; scheduled runs (always
# on the default branch) and `issues`-event runs (also the default branch) pass.
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

  # `can_admins_bypass = false` keeps repo admins subject to whatever protection
  # rules this environment declares. It does NOT bound the deployment-branch
  # policy on its own (it governs the reviewer / wait-timer rules, which this
  # environment does not declare) — the branch pattern below is what restricts
  # access to `main`.
  can_admins_bypass = false

  # CUSTOM branch policy, NOT `protected_branches` (issue #1649). This is the
  # correction that makes the #1289 gate actually work:
  #
  #   `protected_branches = true` restricts deployments to branches covered by
  #   CLASSIC branch protection. This repo protects `main` with a RULESET, and
  #   has no classic protection (`GET /repos/:o/:r/branches/main/protection`
  #   returns 404 "Branch not protected"), so the policy matched nothing and
  #   FAILED OPEN. Verified empirically: with that shape live, an admin
  #   `workflow_dispatch`, a non-admin `workflow_dispatch`, and a non-admin
  #   `push` all reached the environment's secrets from a non-main branch.
  #   `GET /repos/:o/:r/branches/main` reporting `"protected": true` (rulesets
  #   count there, but the deployment policy does not read that field) is what
  #   made the broken config look correct.
  #
  # An explicit branch pattern does not depend on classic protection, so it
  # evaluates regardless of which protection mechanism the repo uses. The
  # matching pattern lives in the companion
  # `github_repository_environment_deployment_policy` resource below —
  # `custom_branch_policies = true` with no pattern would deny every deployment.
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

# The one branch allowed to deploy to `sentry-pipeline`. Exact name, no glob:
# `main` matches only `main`. Without this resource the custom policy above has
# an empty allow-list and every deployment is refused, so the two must land in
# the same apply.
resource "github_repository_environment_deployment_policy" "sentry_pipeline_main" {
  repository     = "monitoring-monorepo"
  environment    = github_repository_environment.sentry_pipeline.environment
  branch_pattern = "main"
}

# `production-infra` and `production-services` predate Terraform ownership and
# were created through the UI (ADR 0050 recorded them as the UI-managed
# precedent). They carry the SAME broken `protected_branches = true` policy, so
# they are adopted here to correct it.
#
# ADOPTION IS A STATE OPERATION, NOT A CONFIG ONE. The identity contract forbids
# top-level `import` blocks, so these resources must be bound to the existing
# environments with an explicit import BEFORE the first apply, or Terraform will
# try to create environments that already exist:
#
#   terraform -chdir=terraform import \
#     github_repository_environment.production_infra \
#     monitoring-monorepo:production-infra
#   terraform -chdir=terraform import \
#     github_repository_environment.production_services \
#     monitoring-monorepo:production-services
#
# After importing, the plan for these two must read `0 to add, N to change,
# 0 to destroy`. Anything else means the shape below does not match live and
# must be corrected before applying. Runbook: docs/terraform.md.
#
# production-infra additionally gates every production Terraform apply behind a
# required reviewer (ADR 0029). That reviewer rule is enforced independently of
# the branch policy, so it is the control that DID hold while the branch policy
# was inert — it is modeled here exactly as it exists live so the adoption
# cannot weaken it. Review the plan for this resource with particular care: a
# diff that drops `reviewers` would remove the production apply gate.
resource "github_repository_environment" "production_infra" {
  repository  = "monitoring-monorepo"
  environment = "production-infra"

  can_admins_bypass = false

  # Human approval for production Terraform applies (ADR 0029). Single active
  # maintainer, so this is operator acknowledgement rather than independent
  # review; revisit when a second maintainer exists.
  reviewers {
    users = [117495] # chapati23
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "production_infra_main" {
  repository     = "monitoring-monorepo"
  environment    = github_repository_environment.production_infra.environment
  branch_pattern = "main"
}

resource "github_repository_environment" "production_services" {
  repository  = "monitoring-monorepo"
  environment = "production-services"

  can_admins_bypass = false

  # No reviewers and no wait timer: this environment records routine deploys
  # from `main` rather than gating them on a human.
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "production_services_main" {
  repository     = "monitoring-monorepo"
  environment    = github_repository_environment.production_services.environment
  branch_pattern = "main"
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
# mints Contents:R/W + Pull-requests:R/W tokens), so server-enforced main-only
# access matters most here.
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
