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
# HISTORY. A `sentry-pipeline` environment held five secrets until ADR 0106
# retired the Sentry triage and autofix pipeline. The audit token was the one
# survivor; it now owns an environment of its own with the same main-only policy
# rather than borrowing a pipeline's.
#
# ROLLOUT ORDER (docs/terraform.md "GitHub Environments"). A workflow
# `environment:` reference AUTO-CREATES an UNPROTECTED Environment if the
# protected one does not already exist, so the environment must be applied
# before the reference reaches `main`. The rename from `sentry-pipeline` is a
# DESTROY-AND-CREATE — the environment name is the resource's identity on
# GitHub, so no `moved` block applies — and the platform stack can only be
# planned or applied by `pnpm tf plan platform` / `pnpm tf apply platform` from
# a clean `main` checkout at freshly fetched `origin/main` (terraform/AGENTS.md;
# ADR 0061). Nothing can be applied from this branch. ADR 0050's two-PR shape
# therefore governs, with the create and the destroy in separate PRs:
#
#   1. PHASE 1 — PR "chore/platform-settings-drift-environment". Purely
#      additive: it creates `platform-settings-drift`, its main-only deployment
#      policy and `platform_settings_drift_audit_token`, the second copy of
#      PLATFORM_SETTINGS_AUDIT_TOKEN. `sentry-pipeline` and its five secrets
#      stay live, so the drift workflow keeps working throughout. BEFORE that
#      apply, confirm the gitignored `terraform/terraform.tfvars` still sets
#      `platform_settings_audit_token` to a non-empty value and read the plan
#      for `github_actions_environment_secret.platform_settings_drift_audit_token`
#      as 1 TO CREATE. The resource is `count`-gated on that tfvar, so an empty
#      or missing value plans as no-op rather than as an error, and the new
#      environment would land with no secret in it.
#   2. Merge phase 1, then apply the platform stack from `main`:
#      `pnpm tf plan platform`, then, after explicit human approval,
#      `pnpm tf apply platform -- -auto-approve`.
#   3. Verify the scheduled `platform-settings-drift.yml` run still reports
#      `state=ok`, not `state=inert`. It is still reading the `sentry-pipeline`
#      copy of the secret at this point; an inert run means phase 1 damaged
#      something and must be fixed before this PR merges.
#   4. Merge THIS PR. It repoints `platform-settings-drift.yml` at the new
#      environment and deletes `sentry-pipeline`, its deployment policy and its
#      five secrets from the configuration. Between the merge and step 5 the
#      environment still exists on GitHub while nothing references it; the
#      workflow reads the phase-1 secret, so there is no inert window.
#      UPDATING THIS BRANCH WITH `main` FIRST NEEDS A RESOLUTION BEYOND THE
#      CONFLICT MARKERS. Phase 1 appends its three new blocks AFTER the
#      `sentry-pipeline` resources this branch deletes, so Git does not read the
#      two sides as the same addition. The merge marks a conflict only on this
#      file's header comment. Below it, Git auto-merges BOTH copies of
#      `github_repository_environment.platform_settings_drift`, of
#      `github_repository_environment_deployment_policy.platform_settings_drift_main`
#      and of
#      `github_actions_environment_secret.platform_settings_drift_audit_token`,
#      outside the markers. Terraform rejects that file with "Duplicate
#      resource configuration". The resolution MUST keep exactly ONE copy of
#      each of the three blocks. The duplicates are byte for byte identical, so
#      either copy will do. Re-run `terraform fmt -check`, `terraform validate`
#      and `pnpm tf:test` on the resolved tree before merging. The conflicts in
#      `scripts/production-infra-identity-contract/surfaces.mjs` land inside
#      their markers and need no extra handling.
#   5. Apply the platform stack from `main` again, the same way, to destroy
#      `sentry-pipeline`. Every workflow that declared
#      `environment: sentry-pipeline` is deleted in this merge, so no run can
#      auto-recreate it between steps 4 and 5. BEFORE this apply, confirm
#      `terraform.tfvars` still sets `platform_settings_audit_token` — the same
#      rollout strips the Sentry lines out of that file, which is the edit that
#      can drop the audit-token line by accident — and read the plan for
#      `github_actions_environment_secret.platform_settings_drift_audit_token`
#      as UNCHANGED. If it plans as destroy, the tfvar was lost; restore it
#      before applying, or the drift audit goes inert.
#   6. Verify the next scheduled `platform-settings-drift.yml` run reports
#      `state=ok`. An inert run means the secret did not reach the job; do not
#      read a green inert run as a passing audit.
#
# Destroying the four Sentry environment secrets (SENTRY_TRIAGE_TOKEN,
# SENTRY_PROJECTION_TOKEN, SENTRY_ARCHIVE_TOKEN, AUTOFIX_APP_PRIVATE_KEY) is
# deliberate; revoke them out of band after step 5. The audit token is never at
# risk in this order: phase 1 creates its replacement before anything is
# destroyed, so no state holds the only copy of a value GitHub cannot read back.
#
# The inert branch of that workflow emits a ::warning:: annotation so steps 3
# and 6 are visible in the run list rather than only in the log.

# `platform-settings-drift` holds exactly one secret, the Administration:Read
# PAT that `.github/workflows/platform-settings-drift.yml` reads. It mirrors the
# `production-infra` shape but carries NO required reviewers (the audit is
# unattended; a reviewer gate would stall every scheduled run) and NO wait
# timer. The explicit main-only branch pattern is the whole control.
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

# PLATFORM_SETTINGS_AUDIT_TOKEN, held on the `platform-settings-drift`
# environment. Fine-grained GitHub PAT (Administration: Read on this repo only),
# consumed only by the `check` job in
# `.github/workflows/platform-settings-drift.yml`. It stays `count`-gated on
# `var.platform_settings_audit_token`, so `terraform apply` still succeeds while
# the value is unset and the audit stays inert until the operator provisions it.
# `value` (not the deprecated `plaintext_value`) matches the repo-level secrets'
# attribute on the `integrations/github ~> 6.12` provider. `environment` is wired
# to the resource above so Terraform creates the Environment before its secret.
resource "github_actions_environment_secret" "platform_settings_drift_audit_token" {
  # checkov:skip=CKV_GIT_4: same state-backed plaintext trade-off as the
  # repo-level mirrors; see the threat-model note in github-secrets.tf.
  count = var.platform_settings_audit_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  environment = github_repository_environment.platform_settings_drift.environment
  secret_name = "PLATFORM_SETTINGS_AUDIT_TOKEN"
  value       = var.platform_settings_audit_token
}
