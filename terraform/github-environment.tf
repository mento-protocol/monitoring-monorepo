# GitHub Environments that gate this repository's server-enforced secrets.
#
# THREAT (issue #1289). Repo-level GitHub Actions secrets are readable by ANY
# workflow run in the repo, including a run of a BRANCH-MODIFIED workflow file
# triggered via `workflow_dispatch` on a feature branch. The in-workflow
# `if: github.ref == 'refs/heads/main'` job guards are evaluated FROM the
# dispatched ref, so a repository writer can push a branch that deletes the
# guard and exfiltrate every repo-level secret the workflow names. The guard is
# a convention, not a security boundary.
#
# FIX. A GitHub Environment whose deployment-branch policy names `main`
# explicitly makes secret access SERVER-ENFORCED: a job that declares
# `environment: platform-settings-drift` only receives the environment's secrets
# when the run's ref satisfies the branch policy, no matter what the branch's
# workflow file says. A `workflow_dispatch` from a feature branch is refused at
# the environment gate before the job starts; scheduled runs (always on the
# default branch) pass.
#
# The policy MUST be an explicit `branch_pattern`, not `protected_branches`
# (#1649) — see the deployment_branch_policy block below for why that shape
# fails open in this repo.
# This mirrors the `production-infra` environment that already gates Terraform
# applies — but `platform-settings-drift` carries NO required reviewers (the
# audit is unattended; a reviewer gate would stall every scheduled run) and NO
# wait timer.
#
# SCOPE. `platform-settings-drift` holds exactly one secret, the
# Administration:Read PAT its workflow reads. The shared CLAUDE_CODE_OAUTH_TOKEN
# stays a repo-level secret (github-secrets.tf) because
# `.github/workflows/claude.yml` consumes it on `pull_request` events from
# feature branches — precisely the surface a main-only environment denies — so a
# main-only environment is fundamentally incompatible with that consumer. Its
# blast radius is inference-quota abuse only (it holds no repo/data write
# capability of its own), an accepted residual.
#
# HISTORY. This environment was named `sentry-pipeline` and held five secrets
# until ADR 0106 retired the Sentry triage and autofix pipeline. The audit token
# was the one survivor; it now owns an environment of its own with the same
# main-only policy rather than borrowing a pipeline's.
#
# ROLLOUT ORDER (docs/terraform.md "GitHub Environments"): a new `environment:`
# workflow reference AUTO-CREATES an unprotected Environment if the protected one
# does not already exist. Therefore this environment + its secrets MUST be
# applied BEFORE the workflow `environment:` references reach `main`. See the
# migration plan: apply this file's resources first (repo-level secrets in
# github-secrets.tf stay in place for that apply), then land the workflow
# references and the repo-level secret removals.
#
# THAT ORDER IS NOT AUTOMATIC FOR THE ADR 0106 RENAME, and the rename is a
# DESTROY-AND-CREATE: the environment name is the resource's identity on
# GitHub, so no `moved` block applies. `platform-settings-drift.yml` carries
# `environment: platform-settings-drift` in the same change, so a plain merge
# would auto-create the environment unprotected, with no
# PLATFORM_SETTINGS_AUDIT_TOKEN in it, and the scheduled audit would take its
# `state=inert` path — a GREEN run in which the #1564 invariant is not checked.
# The apply is a manual human apply on the platform stack, so the operator
# closes the window by hand, in this order:
#
#   0. BEFORE THE APPLY, PROVE THE SURVIVING SECRET IS RE-CREATED. Destroying
#      an Environment destroys its secrets server-side, and GitHub cannot read
#      a secret value back, so a secret destroyed without a matching create is
#      unrecoverable — the operator would have to mint a new Administration:Read
#      fine-grained PAT. `github_actions_environment_secret.platform_settings_audit_token`
#      is `count`-gated on `var.platform_settings_audit_token`, so an empty or
#      missing tfvar plans as destroy-with-NO-create and does not error. The
#      same ADR 0106 rollout also strips the Sentry lines out of the gitignored
#      `terraform/terraform.tfvars`, which is exactly the edit that can drop the
#      audit-token line by accident. Therefore: confirm `terraform.tfvars` still
#      sets `platform_settings_audit_token` to a non-empty value, run
#      `terraform -chdir=terraform plan`, and read the plan for
#      `github_actions_environment_secret.platform_settings_audit_token` as
#      REPLACED — 1 to destroy AND 1 to create. If it shows destroy only, stop
#      and restore the tfvar before applying.
#      The other four environment secrets (SENTRY_TRIAGE_TOKEN,
#      SENTRY_PROJECTION_TOKEN, SENTRY_ARCHIVE_TOKEN, AUTOFIX_APP_PRIVATE_KEY)
#      are destroyed deliberately and must be revoked out of band after merge.
#   1. From the PR branch, `terraform -chdir=terraform apply`. This destroys
#      `sentry-pipeline` and creates `platform-settings-drift` with its
#      main-only policy and the audit-token secret.
#   2. Merge the PR immediately. Between 1 and 2 the workflow on `main` still
#      names `sentry-pipeline`, which no longer exists, so a scheduled run in
#      that window is inert — keep the window under one 05:41 UTC cron tick.
#   3. Verify the next scheduled run of `platform-settings-drift.yml` reports
#      `state=ok`, not `state=inert`. An inert run means the secret did not
#      reach the job; do not read a green inert run as a passing audit.
#
# The inert branch of that workflow emits a ::warning:: annotation so step 3
# is visible in the run list rather than only in the log.

resource "github_repository_environment" "platform_settings_drift" {
  repository  = "monitoring-monorepo"
  environment = "platform-settings-drift"

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

# The one branch allowed to deploy to `platform-settings-drift`. Exact name, no
# glob: `main` matches only `main`. Without this resource the custom policy above
# has an empty allow-list and every deployment is refused, so the two must land
# in the same apply.
resource "github_repository_environment_deployment_policy" "platform_settings_drift_main" {
  repository     = "monitoring-monorepo"
  environment    = github_repository_environment.platform_settings_drift.environment
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

# The one environment-scoped secret, held at `github_actions_environment_secret`
# rather than `github_actions_secret` (repo scope) in github-secrets.tf. It stays
# `count`-gated on its tfvar, so `terraform apply` still succeeds while the value
# is unset and the audit stays inert until the operator provisions it. `value`
# (not the deprecated `plaintext_value`) matches the repo-level secrets'
# attribute on the `integrations/github ~> 6.12` provider. `environment` is wired
# to the resource above so Terraform creates the Environment before its secret.

# PLATFORM_SETTINGS_AUDIT_TOKEN — fine-grained GitHub PAT (Administration: Read
# on this repo only). Consumed only by the `check` job in
# platform-settings-drift.yml, which declares
# `environment: platform-settings-drift`.
resource "github_actions_environment_secret" "platform_settings_audit_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off as the
  # repo-level mirrors; see the threat-model note in github-secrets.tf.
  count = var.platform_settings_audit_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.platform_settings_drift.environment
  secret_name = "PLATFORM_SETTINGS_AUDIT_TOKEN"
  value       = var.platform_settings_audit_token
}
