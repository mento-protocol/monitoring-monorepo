---
title: Monitoring Monorepo Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: agent-instructions
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Monitoring Monorepo

This pnpm monorepo contains the indexer, dashboard, monitoring services,
alerting, probes, shared configuration, and infrastructure. The current package
map and setup live in [`README.md`](README.md); architecture and data flow live
in [`SPEC.md`](SPEC.md).

## Operating Rule (read this before opening PRs)

Read [`docs/context-standards.md`](docs/context-standards.md) before using or
moving repository documentation. Canonical context is current operating truth;
plans and non-canonical notes are historical input that must be verified.

Read the relevant record in [`docs/adr/`](docs/adr/README.md) before changing a
subsystem's architecture. A change that constrains future work, had a real
alternative, and whose rationale is not obvious records an ADR in the same PR;
the procedure is
[`docs/pr-checklists/architecture-decisions.md`](docs/pr-checklists/architecture-decisions.md).

Any change to stateful data flow across indexer, GraphQL, or UI must apply
[`docs/pr-checklists/stateful-data-ui.md`](docs/pr-checklists/stateful-data-ui.md)
before review.

## Cross-Protocol Context

For protocol questions beyond this repo, first use the private
`mento-master-context` router when available. Its location and verify-before-use
rule are in
[`docs/notes/cross-protocol-context.md`](docs/notes/cross-protocol-context.md).

## Safety Boundaries

- **Secrets are IaC-owned.** Never create, rotate, or overwrite secrets with
  `gh secret set`, `vercel env add`, `gcloud secrets versions add`, or another
  one-off provider command. Model them in the owning Terraform/integration path
  and surface the human-approved plan/apply step. See
  [ADR 0030](docs/adr/0030-iac-before-cli-secrets.md) and
  [`docs/deployment.md`](docs/deployment.md).
- **Terraform apply requires explicit human approval.** Plan first. Stack
  ownership, secretless PR planning, production gates, and worktree `-var-file`
  handling are canonical in [`docs/terraform.md`](docs/terraform.md).
- **Forensic drafts stay local.** Use the `forensic-report` skill; sensitive
  drafts belong under gitignored `.investigations/`, never `docs/`.
- When the user is away and a decision, production approval, long completion,
  or plan feedback needs attention, follow
  [`docs/notes/spoken-attention-nudge.md`](docs/notes/spoken-attention-nudge.md).

## Issue-Driven Backlog

GitHub Issues are the canonical active-work queue; `BACKLOG.md` is transition
storage only. Claim before substantive edits:

```bash
pnpm issue:claim --count 3 --agent codex
```

When a PR opens, run `pnpm issue:review --pr <number> --issue <issue>`. Use
`Closes #N` only when the issue's **Done means** is fully satisfied; otherwise
use `Refs #N`. Release incomplete work with `pnpm issue:release` and choose
`agent-ready` versus `needs-grooming` from the remaining clarity. Label,
workboard, Claim ID, and post-merge sync rules live in
[`docs/notes/agent-issue-workflow.md`](docs/notes/agent-issue-workflow.md).

## Agent Quality Gate

Before opening or updating an agent-authored PR, inspect and run the mapped
local-only checks:

```bash
pnpm agent:quality-gate
pnpm agent:quality-gate --run
pnpm agent:autoreview # non-trivial completed batches
pnpm agent:autoreview:test -- --jobs 1  # autoreview runtime changes only
pnpm agent:autoreview --verify-bundle-dir <dir>  # pre-review check; retain the printed manifest
```

The gate never deploys or applies Terraform. It refuses package-script or
package-manager changes until their lifecycle risk is explicitly acknowledged.
Do not run a competing dashboard server/browser suite or second gate in the
same worktree. Background `--run` gates and `git push`; a 600s foreground kill
discards the freshness stamp. Invocation details, parallelism, caching, the
server-side fallback, and common traps live in
[`docs/notes/agent-quality-gate-mechanics.md`](docs/notes/agent-quality-gate-mechanics.md).

Autoreview covers the complete branch-local target without truncation. One
fresh-context reviewer must inspect every prepared-bundle pass, with manifest
verification before and after review. Capture, bundle-integrity,
sensitive-input, and runtime-trust failures are fail-closed; so is an explicitly
selected unavailable semantic engine. Runtime-changing PRs use the compatible
last-reviewed owning-checkout wrapper. Autoreview reviews source only: it runs
no tests and proves no behavior, so mapped gate, browser, generated-artifact,
and runtime checks still apply. Exact target, bundle, isolation, trust,
engine-selection, and command contracts live in
[`docs/notes/agent-quality-gate-mechanics.md`](docs/notes/agent-quality-gate-mechanics.md).

## Prose Style

Applies to every prose surface an agent writes: PR descriptions, ADRs, docs,
issue text, review replies, commit messages, and reports. These are a system;
do not add one-off word or punctuation bans on top of it.

- Prefer the short word. Cut every word that does no work.
- Prefer active voice.
- Plain words over jargon, but never swap a precise technical term for a
  vaguer everyday one.
- State points directly; avoid the "not X, it's Y" contrast shell except
  when the misconception is the point, at most once per document.
- Do not announce what you are about to say — say it.
- Vary sentence shape. Do not pad lists or examples to three for rhythm.
- Break any rule above sooner than writing something unclear or imprecise.

## PR description standard

Every PR description starts with `## The Problem` followed by
`## The Solution`. The problem has at most three plain-language bullets; the
solution explains the approach before implementation detail. The checked-in
template, validator, and `ship` skill own the complete format.

Open every PR through the `ship` skill — on every agent surface, including
hosted sessions; do not hand-roll PR creation. PRs open ready for review,
never as drafts: platform draft defaults do not apply in this repo. Use draft
only when the user explicitly asks for one or required validation is
intentionally still pending, and state that reason in the PR body.

## Deferral rule

Knowingly deferred work requires a GitHub issue before posting the deferral
reply, and the PR's optional `## Deferrals` section must link it. An
evidence-backed won't-fix is not a deferral. See
[`docs/notes/agent-issue-workflow.md`](docs/notes/agent-issue-workflow.md).

## PR Feedback and Readiness

Sweep every feedback surface: top-level comments, review bodies, inline
comments/threads, annotations, and failing logs. Reply before resolving:

- `Fixed in <commit> — <what changed>`
- `Won't fix: <technical reason why>`

Audit sibling surfaces after one instance of a hazard is found; review is a
batch-boundary verifier, not the inner edit loop. Never force-push or amend
while babysitting.

Freeze the intended review baseline before the first pass: the user request,
target/owner, changed files, and non-test changed lines. Classify additions as
in-scope, follow-up, or stop; create an issue before deferring valid follow-up
work, warn near twice the baseline, and pause for reclassification after two
review-triggered patch cycles rather than starting a third automatically.

Before all-clear, run:

```bash
pnpm --silent pr:feedback-state --pr <number> --json
pnpm pr:ready-state --pr <number> --json
```

All-clear requires a clean feedback ledger plus ready-state's current-head
required state, including the current-head
`chatgpt-codex-connector[bot]` PR-description approval. Do not post routine or
duplicate `@codex review` requests. The projection contract, break-glass
behavior, optional-bot treatment, and watch loop live in
[`docs/notes/pr-ready-state.md`](docs/notes/pr-ready-state.md) and the
`babysit-pr` skill.

## Documentation and Review Drift

When a PR changes a command, script, env var, hook, deploy/rollback step, or
canonical workflow, audit every live entry point and ordered runbook in the
same PR. The full search surface and placement policy live in
[`docs/context-standards.md`](docs/context-standards.md).

Before reviews touching recurring hazard classes, read
[`docs/pr-checklists/recurring-review-patterns.md`](docs/pr-checklists/recurring-review-patterns.md).
Apply the repo's explicit do-not-flag layer in
[`docs/pr-checklists/review-prompt-exclusions.md`](docs/pr-checklists/review-prompt-exclusions.md).

## Quick Commands

The canonical command reference is
[`docs/notes/quick-commands.md`](docs/notes/quick-commands.md). Terraform stack
ownership is registered in `terraform.stacks.json`, not inferred from paths.

## Package Routing Index

Open the scoped instructions before editing a package:

| Area                             | Read                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| Aegis service and dashboard      | [`aegis/AGENTS.md`](aegis/AGENTS.md)                             |
| Shared chain/token configuration | [`shared-config/AGENTS.md`](shared-config/AGENTS.md)             |
| Envio indexer                    | [`indexer-envio/AGENTS.md`](indexer-envio/AGENTS.md)             |
| Next.js dashboard                | [`ui-dashboard/AGENTS.md`](ui-dashboard/AGENTS.md)               |
| Hasura-to-Prometheus bridge      | [`metrics-bridge/AGENTS.md`](metrics-bridge/AGENTS.md)           |
| Integration probes               | [`integration-probes/AGENTS.md`](integration-probes/AGENTS.md)   |
| Terraform                        | [`terraform/AGENTS.md`](terraform/AGENTS.md)                     |
| Alert rules and delivery         | [`alerts/AGENTS.md`](alerts/AGENTS.md)                           |
| Governance watchdog              | [`governance-watchdog/README.md`](governance-watchdog/README.md) |
| Root tooling and deploy wrappers | [`scripts/AGENTS.md`](scripts/AGENTS.md)                         |

Indexer coverage includes Celo, Monad, and Polygon FPMM pools, Polygon
Wormhole NTT flows, the Celo v2 Broker path, and Ethereum reserve-yield
accounting.

Dashboard review assumptions such as current pool scale are canonical in
[`docs/pr-checklists/review-prompt-exclusions.md`](docs/pr-checklists/review-prompt-exclusions.md),
not in this router.

## UI Verification

Dashboard UI changes require browser verification. Use
[`docs/notes/dashboard-verification.md`](docs/notes/dashboard-verification.md)
for localhost, auth-state, Playwright, Lighthouse, and React Doctor contracts;
the `/verify-ui` command owns the route-level smoke sequence.

## Agent Tooling and Setup

Reusable project workflows live under `.agents/skills/`; Claude mirrors under
`.claude/skills/` must stay aligned. Codex Cloud routing, status-polling
guidance, the SessionEnd hook, and skill ownership are in
[`docs/notes/codex-agent-skills.md`](docs/notes/codex-agent-skills.md).
Claude slash commands live under `.claude/commands/`.

After cloning or creating a worktree, run `./scripts/setup.sh`. Hosted Claude
setup and Worktrunk hooks are described in
[`docs/notes/worktree-and-web-setup.md`](docs/notes/worktree-and-web-setup.md).
Environment prerequisites and service startup belong to the root and package
READMEs.

## Pre-Push Checklist (server-side work)

Do not assume hooks are installed. Run the Agent Quality Gate explicitly; when
a full manual server-side baseline is required, use the ordered command list in
[`docs/notes/agent-quality-gate-mechanics.md`](docs/notes/agent-quality-gate-mechanics.md).
