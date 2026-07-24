---
title: Infra applies on merge to main behind the production-infra environment gate
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: terraform/infra
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0029 — Infra applies on merge to `main` behind the `production-infra` environment gate

**Status:** Accepted (May–Jun 2026), in force.
**Scope:** terraform/infra

## Context

Manual `terraform apply` from laptops is unauditable and drifts from what's in the
repo. For a sole-maintainer workflow we still want a human approval step and a
recorded deploy history, without requiring a second person for routine service
rollouts.

## Decision

Terraform stacks with CI-apply policy (`alerts-rules`, `alerts-delivery`, `aegis`,
`governance-watchdog`) **apply on merge to `main`**, gated by the **`production-infra`
GitHub Environment** (required reviewer, self-review allowed, admin bypass disabled,
branch restricted to protected `main`). PR runs do **read-only plans** under a
read-only plan service account. Secret-bearing PR plan workflows also export
validation-safe placeholder `TF_VAR_*` values instead of production secrets; the
push/dispatch plan and environment-gated apply paths keep real secrets and
re-plan before any production mutation. The `alerts-rules` PR plan is targeted
to `terraform_data.pr_plan_secretless_guard` plus the non-secret rule groups
that route through the global notification policy; trusted push/dispatch and
apply paths run the full notification graph, including contact points,
notification policies, and direct `notification_settings` rule groups. The
`alerts-delivery` PR plan is targeted to
`terraform_data.pr_plan_secretless_guard`: the handler module still depends on
Slack channel outputs and placeholder-backed Secret Manager versions, while the
Sentry/Slack/QuickNode/GitHub provider graph performs authenticated plan-time
checks and cannot run with dummy credentials. The `platform` stack stays
manual-plan/manual-apply.
Routine service deploys use a separate `production-services` environment that records
history but doesn't require manual approval.

GitHub evaluates Environment protection before it starts the apply job. The
operator therefore approves the commit and the earlier plan job, not a plan
from the blocked apply job. After approval, the apply job checks out that
commit, authenticates, and runs `terraform apply -auto-approve`, which creates
and applies a later plan. The apply output records what happened after the
gate. The current contract has a drift window between the earlier plan and the
later apply-time plan.

Cloud identity is part of the infrastructure gate. Production Terraform apply
jobs use a dedicated WIF pool whose provider requires the immutable repository
ID `1172025835`, repository slug, protected `main` ref, and `production-infra`
environment subject before they can impersonate the seed-project production
applier. PR plans retain their state-only identity, and a separate
cutover-routing PR moves trusted-`main` refresh/drift to a read-only chain
before authority removal.
[ADR 0047](0047-separated-terraform-ci-identities.md) owns the identity split
and its staged bootstrap, routing, proof, and removal procedure.

This repository currently has one maintainer. A `CODEOWNERS` file naming that
same maintainer would route review without creating an independent approval
boundary. Requiring code-owner or latest-push approval without a second
eligible maintainer would also make maintainer-authored changes unavailable or
unmergeable. The repository therefore accepts a one-operator change-control
risk for now: the `main` ruleset keeps required checks and thread resolution,
while the `production-infra` Environment acts as explicit operator
acknowledgement with self-review allowed. Neither control is four-eyes review,
and an ordinary maintainer PR can change a protected workflow and its
checked-in checker together. Do not add `CODEOWNERS` or enable an independent
approval requirement until a second active maintainer can satisfy it.

## Alternatives considered

- **Manual applies only** — rejected: unauditable, drift-prone, and not agent-runnable.
- **Auto-apply with no approval** — rejected: production infra needs a human gate;
  the environment's required-reviewer + self-review setting satisfies it for one
  maintainer.
- **Require code-owner or latest-push approval now** — rejected while the
  repository has one maintainer because it cannot create independent review and
  can block that maintainer's own changes.
- **Disable Environment self-review now** — rejected for the same availability
  reason. Reconsider it with the independent PR approval controls when a second
  active maintainer exists.

## Consequences

- Local `pnpm tf apply` on CI-applied stacks is guarded (clean `main` at
  `origin/main`, or the deliberate `--force-local-apply`).
- Production applies authenticate through a pool isolated from routine deploy
  and PR-plan identities; a token must prove the immutable repository ID,
  repository slug, `refs/heads/main`, and the `production-infra` environment
  subject.
- Environment approval is an operator acknowledgement of the commit and earlier
  plan. It does not prove human review of the apply-time plan or independent
  approval of the code.
- The legacy routine-deployer Token Creator grant may exist only during the
  staged ADR 0047 cutover. First land the trusted-main refresh routing while
  retaining the grant, prove every CI-managed Google-provider stack through
  that checked-in route, and drain and audit the runs. Only a separate final
  removal PR and explicitly approved platform apply may delete the grant.
- Worktrees lack `terraform.tfvars`, so run TF from `main`.
- Agents never apply without explicit human approval; plan first, surface the diff.

## Evidence

- Alerts-infra CI plan/apply PR #558 (2026-05-26);
  governance-watchdog CI apply PR #1001; environment split issue #762.
- Registry policies in [`terraform.stacks.json`](../../terraform.stacks.json)
  and the fail-closed protection verifier in
  [`scripts/verify-github-environment-protection.mjs`](../../scripts/verify-github-environment-protection.mjs).
- Live `production-infra` settings verified through the GitHub API on
  2026-07-24: one required reviewer, self-review allowed, admin bypass
  disabled, and deployment limited to protected branches.
- Live `main` ruleset verified through the GitHub API on 2026-07-24: zero
  required approvals, no code-owner or latest-push approval, required thread
  resolution and status checks, and organization-administrator bypass.
