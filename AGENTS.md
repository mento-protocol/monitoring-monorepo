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
pnpm agent:autoreview --verify-bundle-dir <dir>  # pre-review check; retain the printed manifest for the bound post-check
```

The gate never deploys or applies Terraform. It refuses package-script or
package-manager changes until their lifecycle risk is reviewed and explicitly
acknowledged. Do not run a competing dashboard server/browser suite or second
gate in the same worktree. Invocation details, parallelism, cache behavior, the
server-side full-repository fallback, and common traps live in
[`docs/notes/agent-quality-gate-mechanics.md`](docs/notes/agent-quality-gate-mechanics.md).

Autoreview keeps this repo's branch-local target (base-to-`HEAD` plus dirty
tracked and untracked work), deterministic Mento checks, and repo-selected
checklist/feedback context. It reviews that complete target without truncation,
but direct semantic engines fail closed when the target needs more than one
prompt. Prepared bundles retain a bounded, lossless pass index that one
fresh-context reviewer must inspect completely. Their completion marker binds
the evidence manifest; run `--verify-bundle-dir` immediately before review,
retain its printed digest outside the bundle, then pass that digest to the
post-review check with `--expected-bundle-manifest`. Automatic feedback capture
pins the canonical GitHub repository. The owning-checkout default semantic
helper, feedback-state modules, and checklist policy come from one pinned
`origin/main` object rather than a PR-selected base, mutable worktree, or
branch-controlled package scripts; wrapper-owned Node launches discard
`NODE_OPTIONS` and `NODE_PATH`, and checklist edits remain diff evidence. Direct
and prepared capture enforce a cumulative byte budget before review input
accumulates in memory or staging sidecars.
Semantic engines run in an isolated empty workspace with restricted project
configuration and environment; reviewer web search is disabled by default and
requires explicit `--web-search`. Review inputs fail closed on sensitive
content, including wallet recovery phrases.
Inside an active Codex sandbox, the adapter may choose its local deterministic
engine only when no engine was explicitly selected; an explicitly selected
unavailable semantic engine fails closed. Autoreview does not run tests;
`pnpm agent:quality-gate --run` owns test execution.
Autoreview is source review, not runtime or behavior proof, so all mapped gate,
browser, generated-artifact, and runtime verification still applies.

## PR description standard

Every PR description starts with `## The Problem` followed by
`## The Solution`. The problem has at most three plain-language bullets; the
solution explains the approach before implementation detail. The checked-in
template, validator, and `ship` skill own the complete format.

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
pnpm pr:ready-state --pr <number> --json
```

All-clear requires its current-head required state to be ready, including the
current-head `chatgpt-codex-connector[bot]` PR-description approval. Do not post
routine or duplicate `@codex review` requests. The feedback projection,
break-glass contract, optional-bot treatment, and watch loop live in
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
`.claude/skills/` must stay aligned. Runtime setup, autoreview bundle behavior,
and skill ownership are in
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
