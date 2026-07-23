---
title: Monitoring Monorepo Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
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

The full claim → implement → gate → autoreview → ship → babysit → ready-state →
merge loop, with its non-negotiables, is one card:
[`docs/notes/pr-operating-card.md`](docs/notes/pr-operating-card.md). Read it
first; open the authority docs it names only when a step needs their depth.

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

## PR Workflow

GitHub Issues are the canonical active-work queue; `BACKLOG.md` is transition
storage only. Claim before substantive edits, then follow the
[operating card](docs/notes/pr-operating-card.md) through implementation,
review, shipping, readiness, and merge sync:

```bash
pnpm issue:claim --count 3 --agent codex
pnpm agent:quality-gate
pnpm agent:quality-gate --run
```

Claude cloud sessions run issue helpers only behind the capability gate;
otherwise use the MCP workboard fallback in
[`docs/notes/github-tooling-surfaces.md`](docs/notes/github-tooling-surfaces.md).
For non-trivial batches, use the card's surface-correct autoreview flow. Inside
an active Codex session that means a verified prepared bundle and one
fresh-context reviewer; a bare deterministic review is not the semantic
closeout. Autoreview proves source review only, so mapped tests, browser checks,
generated artifacts, and runtime evidence still apply.

Open every PR through the `ship` skill, ready for review unless the user
explicitly requests a draft or required validation is intentionally pending.
The body starts with `## The Problem` (at most three plain-language bullets)
then `## The Solution` (approach before implementation detail). Use `Closes
#N` only when the issue's Done means is complete; otherwise use `Refs #N`.
Knowingly deferred valid work needs a linked issue before the deferral reply.

Reply to every review item before resolving it:

- `Fixed in <commit> — <what changed>`
- `Won't fix: <technical reason why>`

Never force-push or amend while babysitting. Before all-clear, require a clean
feedback ledger followed by current-head readiness:

```bash
pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
```

The current-head `chatgpt-codex-connector[bot]` description approval is part of
readiness. Never merge without the user's explicit approval for that specific
merge. Claude cloud sessions use these helpers only behind the capability gate;
the MCP fallback and its qualified all-clear live in
[`docs/notes/github-tooling-surfaces.md`](docs/notes/github-tooling-surfaces.md).
Label, workboard, Claim ID, release, and merge-sync depth lives in
[`docs/notes/agent-issue-workflow.md`](docs/notes/agent-issue-workflow.md).

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
