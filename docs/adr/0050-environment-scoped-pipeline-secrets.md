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

**Status:** Accepted (Jul 2026) — **its central premise is disproven; the chosen
control does not deliver the intended protection.** Amended 2026-07-27; a
replacement decision is pending in
[#1649](https://github.com/mento-protocol/monitoring-monorepo/issues/1649).
**Scope:** terraform / ci (Sentry pipeline first; the pattern for future
secret-bearing scheduled workflows).

> **Correction (2026-07-27).** This ADR assumed a deployment-branch policy makes
> environment secrets unreachable from a non-main ref. **GitHub does not gate
> `workflow_dispatch` on deployment-branch policies.** Verified empirically:
> both a repo admin and a **non-admin `write` collaborator** dispatched a
> guard-stripped branch off `main` and each received the environment secret.
>
> What the environment still delivers: **scoping** — only jobs that declare it
> receive these secrets, instead of every workflow run in the repo. What it does
> **not** deliver: the branch boundary against a compromised writer that #1289
> set out to build.
>
> Nor do the in-workflow `if: main` guards close the gap. Two problems:
>
> - **They are absent where the value is highest.** Every environment-declaring
>   job in `sentry-triage-agent.yml` (`select`, `triage`, `project`) and
>   `sentry-autofix.yml` (`select`, `finalize`) carries **no `github.ref`
>   guard**, so an off-main dispatch reaches them with `SENTRY_TRIAGE_TOKEN` and
>   `AUTOFIX_APP_PRIVATE_KEY` in scope. Only `sentry-triage-ingest.yml`,
>   `sentry-triage-archive.yml`, and `platform-settings-drift.yml` carry one.
>   (`SENTRY_PROJECTION_TOKEN` is the exception: its `env:` expression is
>   ref-gated to `main`, so it resolves to `''` off-main.)
> - **A guard could not be a boundary anyway.** The branch author controls the
>   entire workflow file, so they can declare `environment: sentry-pipeline`
>   from any job they write, guard or not. Adding guards would reduce accidental
>   off-main dispatch of the existing workflows; it would not bound an attacker.
>
> Everything below is retained as the original record. Read the Decision and
> Consequences sections as **superseded** on the enforcement claim. Replacement
> options — separate repository, short-lived OIDC/App-minted credentials, or
> removing `workflow_dispatch` from secret-bearing workflows — are in #1649.

## Context

The Sentry triage/autofix pipeline (ADR 0036) holds five repo-level Actions
secrets, including the autofix App private key, which mints Contents:R/W +
Pull-requests:R/W installation tokens. Repo-level secrets are readable by any
workflow run in the repository — including a `workflow_dispatch` of a feature
branch whose copy of the workflow file was rewritten to drop its
`if: github.ref == 'refs/heads/main'` guard. The guard is evaluated from the
dispatched ref, so it is a convention the branch author controls, not a
boundary (issue #1289).

GitHub Environments were expected to invert that: when a job declares
`environment:`, the secrets scoped to that environment would be injected only if
the run's ref satisfied the environment's deployment-branch policy, enforced
server-side before the job starts and independent of the branch's workflow
content. **That expectation was wrong for `workflow_dispatch`** — see the
correction above; branch policies constrain `push`/`pull_request`/`deployment`
by ref, but not dispatch runs.

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
  widen the policy) and then dispatch. That live settings edit is **not**
  continuously detected: the identity contract hash-pins only the checked-in
  Terraform block, so a _source_ change to the flag fails CI, but a change made
  through GitHub Settings leaves the file untouched and is reconciled only on the
  next manual `pnpm tf apply platform` (the platform stack is manual-apply and
  excluded from `terraform-drift.yml`; `platform-settings-drift.yml` audits only
  the workflow-token permission). The flag's value is still defense-in-depth: it
  forces any admin bypass to be an out-of-band settings change instead of a
  silent one-step dispatch. Containing a compromised admin outright would need
  the credential outside repo-admin control (the separate-repository alternative
  below), out of scope here.
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

- ~~A branch-rewritten `workflow_dispatch` can no longer reach the pipeline's
  secrets; an off-main dispatch of a gated job is refused at the environment
  gate before the job starts.~~ **False — see the correction at the top.** An
  off-main dispatch still receives the secrets, for any user with `write`. What
  did change: the secrets are now visible only to jobs that declare the
  environment, rather than to every workflow run in the repo.
- The platform PAT permission set grows by Environments: Read/write
  (documented in `providers.tf`, `variables.tf`, `terraform.tfvars.example`).
- New secret-bearing scheduled workflows should scope their secrets to an
  environment following this pattern rather than adding repo-level secrets
  with `if:` guards.
- Rollout steps live in `docs/notes/sentry-triage-pipeline.md`
  ("GitHub Environment rollout"); the environment-creation phase is
  #1289 phase 1, the enforcement flip is phase 2.
