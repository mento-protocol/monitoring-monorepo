---
title: Pipeline secrets are gated by a Terraform-managed GitHub Environment
status: active
owner: eng
canonical: true
last_verified: 2026-09-16
scope: terraform / ci
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0050 — Pipeline secrets are gated by a Terraform-managed GitHub Environment

**Status:** Accepted (Jul 2026). Amended 2026-07-27 — the decision stands, but
its first implementation used a branch-policy mechanism that does not work in
this repo and silently failed open; see "Correction" below and
[#1649](https://github.com/mento-protocol/monitoring-monorepo/issues/1649).
**Scope:** terraform / ci (the pattern for every secret-bearing scheduled
workflow).

Amended 2026-09-16: [ADR 0106](0106-sentry-triage-moves-to-operator-skills.md)
retired the Sentry pipeline this pattern was built for. The decision stands and
now gates `platform-settings-drift`, `production-infra` and
`production-services`; the Sentry examples have been replaced with the surviving
ones.

## Correction (2026-07-27) — use an explicit branch pattern

The environment was created with
`deployment_branch_policy.protected_branches = true`, which admits only branches
covered by **classic** branch protection. This repo protects `main` with a
**ruleset** and has no classic protection
(`GET /repos/:o/:r/branches/main/protection` → `404 Branch not protected`), so
the policy matched nothing and **failed open**.

Verified empirically before the fix: an admin `workflow_dispatch`, a **non-admin
`write`** `workflow_dispatch`, and a **non-admin `push`** each reached the
environment's secrets from a non-main branch. The probe secret has no repo-level
copy, so it came through the environment. `GET .../branches/main` reporting
`"protected": true` — rulesets count for that field, but the deployment policy
does not read it — is what made the broken configuration look correct.

The fix keeps this ADR's decision and replaces the mechanism:

```hcl
deployment_branch_policy {
  protected_branches     = false
  custom_branch_policies = true
}
# plus a github_repository_environment_deployment_policy with branch_pattern = "main"
```

An explicit pattern does not depend on classic protection. `production-infra`
and `production-services` carried the same broken shape and are corrected and
adopted into Terraform at the same time; `production-infra`'s required-reviewer
rule is enforced independently of the branch policy, so the production apply
gate held throughout.

Two lessons are folded into the tooling: `can_admins_bypass` governs the
reviewer / wait-timer rules, not the branch policy, so it was never the control
it was described as; and `scripts/verify-github-environment-protection.mjs` now
reads the deployment-branch-policy allow-list rather than only asserting the
configured shape — asserting configuration is what let an open gate look
verified.

## Context

Scheduled workflows hold high-value repo-level Actions secrets — at the time
this was written, five of them, including a GitHub App private key that minted
Contents:R/W + Pull-requests:R/W installation tokens. Repo-level secrets are
readable by any workflow run in the repository — including a
`workflow_dispatch` of a feature branch whose copy of the workflow file was
rewritten to drop its `if: github.ref == 'refs/heads/main'` guard. The guard is evaluated from the
dispatched ref, so it is a convention the branch author controls, not a
boundary (issue #1289).

GitHub Environments invert that: when a job declares `environment:`, the
secrets scoped to that environment are injected only if the run's ref satisfies
the environment's deployment-branch policy, which is enforced server-side
before the job starts — independent of the branch's workflow content.

## Decision

A secret-bearing scheduled workflow's secrets move from repo scope to a GitHub
Environment whose deployment-branch policy allows `main` only. The environment
and its secrets are **Terraform-managed** (`terraform/github-environment.tf`,
platform stack) — the secrets were already IaC-owned (ADR 0030), so their gate
is too, and every platform apply reconciles drift.

> Amended: the policy is expressed as an explicit `branch_pattern = "main"`, not
> `protected_branches = true` — see the Correction above. `production-infra` and
> `production-services` were UI-managed when this ADR was written; they carried
> the same broken shape and were corrected and adopted into Terraform alongside
> it, so all three are now Terraform-managed.

Boundaries of the decision:

- **No required reviewers or wait timer** on an unattended environment. A
  reviewer gate would stall every scheduled run, so the `main` branch pattern is
  the control. `production-infra` is the exception: it declares a reviewer
  because a human approves every production apply (ADR 0029).
- **`can_admins_bypass = false`, and what it is not.** It keeps repo admins
  subject to whatever protection rules an environment declares — the required
  reviewer and wait timer. It does **not** govern the deployment-branch policy,
  and an unattended environment declares no reviewer or timer, so on
  `platform-settings-drift` the flag is inert. It is set because `false` is the strictest value and costs
  nothing, not because it restricts branches. (Earlier revisions of this ADR
  described it as closing an admin branch-policy bypass; that was wrong — the
  admin dispatch it was meant to explain succeeded because the branch policy
  itself was inert, per the Correction above.)
- **A compromised repo admin is out of scope.** Holding Administration:write,
  they can edit the environment — widen the branch pattern, drop a rule — and
  then dispatch. That live settings edit leaves the checked-in Terraform
  untouched, so the identity contract (which hashes source) does not see it, and
  no drift job monitors the manual-apply platform stack's environment settings;
  only the next `pnpm tf apply platform -- -auto-approve` reconciles it.
  Containing that would
  need the credential outside repo-admin control (the separate-repository
  alternative below).
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
  the `environment:` reference to the secret-bearing jobs and removes the repo
  copies. The order is load-bearing: a workflow `environment:` reference
  reaching `main` before the environment exists auto-creates it **unprotected**.
  Any future environment introduced this way must land applied-and-protected
  before its first workflow reference merges. ADR 0106's rename of
  `sentry-pipeline` to `platform-settings-drift` is subject to the same order.
  It satisfies it without splitting into two PRs: the platform stack is a
  manual human apply, so the operator applies it from the PR branch and merges
  immediately, then confirms the next scheduled `platform-settings-drift` run
  reports `state=ok` rather than the green `state=inert` no-op. That procedure
  is written out at `terraform/github-environment.tf` "ROLLOUT ORDER". Use the
  two-PR shape wherever the apply is automated and the operator cannot hold the
  window closed by hand.

## Alternatives considered

- **Keep the in-workflow `if: main` guards.** Zero cost, but a convention any
  writer's branch can delete; it cannot bind GitHub's secret injection.
  Retained as defense-in-depth, not as the boundary.
- **UI-managed environment** (what `production-infra` and `production-services`
  were until #1649). Leaves the security-critical branch policy invisible to
  review and outside drift reconciliation; a runtime verify script must then
  assert it. Terraform management makes the policy a reviewed, reconciled
  artifact — and the UI-managed pair carried the broken `protected_branches`
  shape unreviewed for exactly that reason, which is why they were adopted into
  Terraform rather than left as a precedent. The cost is a wider platform PAT:
  environment-secret writes route through the fine-grained **Environments:
  Read/write** repository permission (not "Secrets"), which the platform PAT
  must hold or the apply 403s.
- **A separate repository per credential boundary.** Strongest isolation,
  disproportionate operational cost for one pipeline.

## Consequences

- A branch-rewritten `workflow_dispatch` can no longer reach a gated job's
  secrets; an off-main dispatch is refused at the environment gate before the
  job starts (previously a graceful in-job no-op).
- The platform PAT permission set grows by Environments: Read/write
  (documented in `providers.tf`, `variables.tf`, `terraform.tfvars.example`).
- New secret-bearing scheduled workflows should scope their secrets to an
  environment following this pattern rather than adding repo-level secrets
  with `if:` guards.
- Rollout steps live in [`docs/terraform.md`](../terraform.md)
  ("GitHub Environments"); the environment-creation phase is #1289 phase 1, the
  enforcement flip is phase 2.
