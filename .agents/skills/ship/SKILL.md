---
name: ship
description: '[repo-skill] Ship monitoring-monorepo changes through the repo''s Codex-compatible workflow: preflight, direct author checks, closeout review, commit, push, PR create/update, readiness babysitting, and required production closeout. Use when the user says "ship it", "/ship", "push this", "open a PR", "create a PR", "publish this", or "send it" in this repo.'
title: Ship Skill
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Ship

Codex-facing entry point. It holds no rules of its own: everything binding
lives in the authority docs below, which every surface reads. A Claude session
loads the user-global `ship` skill instead of this file
([`codex-agent-skills.md`](../../../docs/notes/codex-agent-skills.md#claude-global-store-shadowing)),
so a rule written here and nowhere else would reach Codex only.

After bootstrap, work
[`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md) steps 2-9.
Run its preflight before agent-invoked repository code. It does not attest
bootstrap; setup has a separate [trust boundary](../../../docs/notes/worktree-and-web-setup.md#bootstrap-trust-boundary).

| Decision                                                       | Authority                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Author-check triggers and result records                       | [`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md#the-loop)                 |
| Autoreview engine, bundle preparation and verification         | [`agent-quality-gate-mechanics.md`](../../../docs/notes/agent-quality-gate-mechanics.md)    |
| Readiness and feedback projections                             | [`pr-ready-state.md`](../../../docs/notes/pr-ready-state.md)                                |
| Surface detection, gh capability gate, gh→MCP mapping          | [`github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md)              |
| UI browser verification and the `## Visual comparison` section | [`dashboard-verification.md`](../../../docs/notes/dashboard-verification.md)                |
| Claim, deferrals, issue lifecycle                              | [`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md)                    |
| Production closeout                                            | [`../../../docs/deployment.md`](../../../docs/deployment.md) and the owning package runbook |

## What this repo adds

- **Repository identity before agent-invoked code**: After bootstrap, resolve
  `CURRENT_REPO`, `BASE_REPO`, the PR, remotes, and base. Stop fork or
  cross-repository heads. Bind probes to `BASE_REPO`; a failed query does not
  prove that no PR exists. Use the resolved base for all diff checks. Before a
  new PR, bind and reuse its intended base. Use `main` only for unstacked work.
- **Author checks before ready publication**: Apply every matching row in card
  step 3. Format every intended changed file before those checks. Record each
  result in `## Validation`. Reapply affected rows after a material fix, base
  integration, or formatter change during commit. Pre-push runs no repository
  verification.
  Then run the closeout review for non-trivial behavioural, workflow, security,
  data-flow, infrastructure, or UI changes. **Which closeout depends on the surface**, and a bare
  `pnpm agent:autoreview` is not always it: inside an active Codex session that
  silently selects the local deterministic engine, so the prepared-bundle
  fresh-context flow is required instead. Card step 4 owns the choice — follow
  it rather than the bare command.
- **PRs open ready for review.** Drafts suppress the automated AI reviews this
  workflow depends on.
- **`scripts/pr/check-pr-description.mjs` enforces `## The Problem` then
  `## The Solution` in CI**, in that order, ahead of all other content. The
  full four-section description shape is the repo template
  `.github/PULL_REQUEST_TEMPLATE.md`, bound by card step 5.
- **Never post routine or duplicate `@codex review` requests**, and never tag
  `chatgpt-codex-connector` directly.
- **Deep security scan** (`claude-security`) is developer-installed and Claude
  Code only. This repo does not declare it. Where unavailable, aim the direct
  author checks and closeout review at the sensitive surfaces and record
  `Claude Security scan: skipped (<surface>)` in the final summary.
- **Done is not merge when Done means includes live behaviour.** Card step 9
  owns the closeout.
