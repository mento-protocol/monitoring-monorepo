---
title: Pipeline secrets are gated by a Terraform-managed GitHub Environment
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
scope: terraform / ci
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0050 — Pipeline secrets are gated by a Terraform-managed GitHub Environment

**Status:** Accepted (Jul 2026), two-phase rollout in progress.
**Scope:** terraform / ci (Sentry pipeline first; the pattern for future
secret-bearing scheduled workflows).

## Context

The Sentry triage/autofix pipeline (ADR 0036) holds five repo-level Actions
secrets, including the autofix App private key, which mints Contents:R/W +
Pull-requests:R/W installation tokens. Repo-level secrets are readable by any
workflow run in the repository — including a `workflow_dispatch` of a feature
branch whose copy of the workflow file was rewritten to drop its
`if: github.ref == 'refs/heads/main'` guard. The guard is evaluated from the
dispatched ref, so it is a convention the branch author controls, not a
boundary (issue #1289).

GitHub Environments invert that: when a job declares `environment:`, the
secrets scoped to that environment are injected only if the run's ref satisfies
the environment's deployment-branch policy, which is enforced server-side
before the job starts — independent of the branch's workflow content.

## Decision

Sentry-pipeline secrets move from repo scope to a `sentry-pipeline` GitHub
Environment whose deployment-branch policy allows protected branches only
(`main`). The environment and its secrets are **Terraform-managed**
(`terraform/github-environment.tf`, platform stack), unlike the pre-existing
UI-managed environments (`production-infra`, `production-services`) — the
secrets were already IaC-owned (ADR 0030), so their gate is too, and every
platform apply reconciles drift.

Boundaries of the decision:

- **No required reviewers or wait timer.** The pipeline is unattended and
  scheduled; a reviewer gate would stall every run. The branch policy is the
  control — but only while admins cannot silently bypass it, so the environment
  also sets `can_admins_bypass = false` (see the admin-bypass boundary below).
  (This is why `scripts/verify-github-environment-protection.mjs`, which asserts
  reviewer gates for `production-infra`, does not apply here.)
- **`can_admins_bypass = false`, and its limit.** With the default (`true`) a
  repo admin bypasses the branch policy outright — an admin `workflow_dispatch`
  of a gated job from an off-main branch reads the secret with no config change
  (verified empirically, #1289). Setting it false closes that silent path. It
  does **not** by itself contain a fully-compromised repo admin: holding
  Administration:write, they could first edit this environment (re-enable bypass,
  widen the policy) and then dispatch — drift Terraform and the identity contract
  reconcile only on a later run. The flag's value is defense-in-depth: any admin
  bypass now requires a visible, drift-detectable settings change instead of a
  one-step dispatch. Containing a compromised admin outright would need the
  credential outside repo-admin control (the separate-repository alternative
  below), out of scope here. The identity contract hash-pins the flag, so
  flipping it fails CI.
- **`CLAUDE_CODE_OAUTH_TOKEN` stays repo-level.** `claude.yml` reads it on
  `pull_request` events from feature branches — exactly what a main-only policy
  denies. It is inference-only (no repo write capability), so its residual
  exposure is bounded and unchanged.
- **Identity-contract coverage moves with the secrets.**
  `github_actions_environment_secret` is an identity-bearing type in the
  production-infra identity contract; the environment-scoped secret blocks stay
  hash-pinned exactly as their repo-level predecessors were.
- **Two-phase rollout, in order.** Phase 1 creates the protected environment
  and mirrors the secrets (purely additive; repo copies remain). Phase 2 adds
  `environment: sentry-pipeline` to the secret-bearing jobs and removes the
  repo copies. The order is load-bearing: a workflow `environment:` reference
  reaching `main` before the environment exists auto-creates it **unprotected**.
  Any future environment introduced this way must land applied-and-protected
  before its first workflow reference merges.

## Alternatives considered

- **Keep the in-workflow `if: main` guards.** Zero cost, but a convention any
  writer's branch can delete; it cannot bind GitHub's secret injection.
  Retained as defense-in-depth, not as the boundary.
- **UI-managed environment (the `production-infra` precedent).** Works, but
  leaves the security-critical branch policy invisible to review and outside
  drift reconciliation; a runtime verify script must then assert it. Terraform
  management makes the policy a reviewed, reconciled artifact. The cost is a
  wider platform PAT: environment-secret writes route through the fine-grained
  **Environments: Read/write** repository permission (not "Secrets"), which the
  platform PAT must hold or the apply 403s.
- **A separate repository per credential boundary.** Strongest isolation,
  disproportionate operational cost for one pipeline.

## Consequences

- A branch-rewritten `workflow_dispatch` can no longer reach the pipeline's
  secrets; an off-main dispatch of a gated job is refused at the environment
  gate before the job starts (previously a graceful in-job no-op).
- The platform PAT permission set grows by Environments: Read/write
  (documented in `providers.tf`, `variables.tf`, `terraform.tfvars.example`).
- New secret-bearing scheduled workflows should scope their secrets to an
  environment following this pattern rather than adding repo-level secrets
  with `if:` guards.
- Rollout steps live in `docs/notes/sentry-triage-pipeline.md`
  ("GitHub Environment rollout"); the environment-creation phase is
  #1289 phase 1, the enforcement flip is phase 2.
