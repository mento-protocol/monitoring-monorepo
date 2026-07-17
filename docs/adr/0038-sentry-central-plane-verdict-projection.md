---
title: Central Sentry triage plane with owning-repo verdict projection
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
scope: ci/process
date: 2026-07
---

# ADR 0038 — Central Sentry triage plane with owning-repo verdict projection

**Status:** Accepted (Jul 2026), in force. Refines
[ADR 0036](0036-sentry-triage-pipeline.md) Stage C ("phased mutations").
**Scope:** ci/process

## Context

ADR 0036 runs Sentry triage as a staged GitHub Actions pipeline in **this**
repo, with GitHub Issues as the durable queue: one deterministic ingest turns
every new/regressed Sentry issue org-wide into a redacted queue stub here, and a
read-only agent posts a structured verdict (`code-fix` / `config-fix` /
`upstream-transient` / `needs-human`). ADR 0036 named Stage C ("phased
mutations") but deliberately left its shape open until the first live run
produced evidence.

Two facts from that run shape this decision:

1. **Org-wide correlation is the whole point of a central queue.** In the first
   live batch, four separate governance Sentry groups clustered into one
   underlying bug — visible only because every project's issues funnel into one
   ledger with one dedup/correlation surface. A per-repo split would have
   scattered those four across repos and lost the link.
2. **The queue is a machine ledger; the human artifact lives where people
   work.** The redacted stub in this (public) repo is a coordinate record, not a
   place a product engineer would ever look. Actionable findings for
   frontend-monorepo, mento-analytics-api, and minipay-dapp need to land as
   real, readable issues in those repos. This was already being done by hand
   (manual precedent: mento-protocol/frontend-monorepo#529 and
   monitoring-monorepo#1302) — the decision is to make it deterministic.

The constraint that makes this non-trivial: it crosses a repo boundary with a
write credential, carrying agent-authored (untrusted) text out of the central
plane. ADR 0030 (IaC-before-CLI secrets) and ADR 0036's trust boundary
(agent output is untrusted, deterministic steps hold all write authority) both
apply.

## Decision

**Keep a single central triage plane in monitoring-monorepo, and project
actionable verdicts into the owning repo as human-readable issues via a
deterministic step.**

- **Central plane, not per-repo pipelines.** All ingest, triage, quota,
  kill-switch, run-record, and accuracy measurement stay in one place, against
  one queue, so org-wide dedup/correlation and a single infra/quota/accuracy
  dataset are preserved.
- **Verdict projection (deterministic, no LLM).** A new step in
  `.github/workflows/sentry-triage-agent.yml`, driven by
  `scripts/sentry-triage-project.mjs`, runs AFTER the deterministic verdict-label
  step and BEFORE the queue-close step. For a `code-fix` / `config-fix` verdict
  whose `affected_repo` is an EXTERNAL owning repo, it files an issue in that
  repo, labels the stub `sentry:projected`, comments the projected URL, and the
  stub still closes (queue hygiene). `needs-human` and `upstream-transient` are
  never projected.
- **The trust boundary is a fixed allowlist.** `affected_repo` is untrusted
  agent text, validated against exactly `frontend-monorepo`,
  `mento-analytics-api`, `minipay-dapp`; anything else (including this repo) is a
  no-op with a `::warning::`. The projected body renders only
  redaction-governed verdict-contract fields, the Sentry permalink, a back-link,
  and a fixed footer, with every agent-derived string neutralized (control-char
  strip, backtick-defang, mention-defang) and multi-line fields fenced.
  Idempotent by Sentry SHORT-ID (a hidden back-link marker searched across all
  states) so re-runs and regressions never duplicate.
- **Issues-write ONLY, dedicated fine-grained PAT.** A `sentry-triage-projector`
  PAT with Issues Read+Write on exactly those three repos — no contents, no
  pull-requests — stored as the `count`-gated Actions secret
  `SENTRY_PROJECTION_TOKEN` in the platform Terraform stack (ADR 0030), like
  `SENTRY_TRIAGE_TOKEN`. The token is step-scoped env so it reaches only the
  projection step, never the triage agent; the agent's allowlist and permissions
  are untouched. Absent PAT → graceful no-op. Cross-repo fix **PRs** remain a
  later phase (ADR 0036 Stage C Phase 3, tracked in #1279) — this ADR authorizes
  Issues-write only.

## Alternatives considered

- **Per-repo triage pipelines** (each repo runs its own ingest + triage) —
  rejected. It fragments the infra/quota/accuracy dataset into N copies, N
  kill switches, and N secret sets, and — decisively — destroys org-wide
  dedup/correlation: the first-run "4 governance groups → 1 bug" clustering is
  invisible once each project only sees its own errors. The read-only triage
  brain benefits from one context, not N.
- **Queue-in-owning-repos** (one central triage brain, but each owning repo
  hosts its own queue stubs) — rejected. It splits the machine ledger, so there
  is no single correlation surface and no single place to measure verdict
  accuracy; the public-repo redaction contract (ADR 0036) would have to be
  re-established and audited per repo; and it inverts the ledger/artifact split —
  the queue is a machine ledger that belongs in one operable place, while the
  human artifact is the projected outcome. Projection gives owning repos the
  human artifact without moving the ledger.
- **Let the triage agent open the owning-repo issue directly** — rejected. It
  would hand a prompt-injectable LLM a cross-repo write credential, exactly the
  boundary ADR 0036 draws. Projection is deterministic and the token never
  reaches the agent.

## Consequences

- A cross-repo write credential now exists. It is bounded to Issues-write on
  three repos, `count`-gated, and carries no `prevent_destroy` (brand-new, no
  external consumer — mirrors `SENTRY_TRIAGE_TOKEN`). It is step-scoped so it is
  never exposed to the triage agent.
- Agent-authored text leaves the central plane, but only redaction-governed
  verdict fields, neutralized and length-bounded; no raw Sentry payload is
  fetched or copied. A leaked/wrong verdict can create a readable owning-repo
  issue (Issues-write) but cannot mutate code or Sentry.
- Projection is idempotent across regressions: a reopened-then-re-triaged stub
  reuses the existing owning-repo issue rather than filing a duplicate.
- Owning-repo issues are advisory; the fix still happens the normal way in that
  repo. Fix-PR automation stays out of scope (Phase 3, #1279).
- The queue-close comment for `code-fix`/`config-fix` now records the projection
  outcome (linked issue, or an explicit "projection skipped" while the PAT is
  unprovisioned) — visible, not silent.

## Evidence

- Implemented in the PR for issue
  [#1339](https://github.com/mento-protocol/monitoring-monorepo/issues/1339):
  `scripts/sentry-triage-project.mjs` (+ tests), the projection/close steps in
  `.github/workflows/sentry-triage-agent.yml`, the `count`-gated
  `github_actions_secret.sentry_projection_token` in
  `terraform/github-secrets.tf` (+ variable + tfvars.example), the
  `sentry:projected` label bootstrap in `scripts/sentry-triage-ingest.mjs`, and
  the `## Verdict projection` section + runbook + diagrams in
  `docs/notes/sentry-triage-pipeline.md`.
- First-run correlation evidence: four governance Sentry groups clustered into
  one underlying bug (org-wide dedup requires the central queue).
- Manual precedent for owning-repo projection: mento-protocol/frontend-monorepo#529
  and monitoring-monorepo#1302.
- Pipeline tracker [#1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282);
  refines [ADR 0036](0036-sentry-triage-pipeline.md) Stage C.
