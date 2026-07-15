---
title: Sentry triage/autofix runs as a staged GitHub Actions agent pipeline with a GitHub-Issue queue
status: active
owner: eng
canonical: true
last_verified: 2026-07-15
scope: ci/process
date: 2026-07
---

# ADR 0036 — Sentry triage/autofix: staged GitHub Actions agent pipeline with a GitHub-Issue queue

**Status:** Accepted (Jul 2026), in force.
**Scope:** ci/process

## Context

The `mento-labs` Sentry org spans 6 projects across 4 repos (this repo's
ui-dashboard, mento-analytics-api, frontend-monorepo ×3 apps, minipay-dapp) and
produces ~31 new issue groups/week, of which roughly 60% is operational noise
(CSP reports, RPC timeouts, chunk-load errors) rather than fixable code bugs.
We want automated investigation plus fix-or-close, org-wide. Sentry's own Seer
was tried and rejected on quality/fit; hard constraints: agents never merge PRs,
secrets are IaC-managed (ADR 0030), and the team runs Claude Max + Codex
subscriptions.

Two findings shaped the decision more than any feature comparison:

1. **A prior experiment failed silently.** A personal Claude cloud routine
   polled one project weekly with a "fix and PR" prompt. It fired for weeks and
   produced zero auditable output — and nobody noticed. The dominant failure
   mode of this automation category is not wrong fixes; it is _unauditable
   automation going dark_.
2. **Platform constraints (verified 2026-07-15):** Codex has in-app scheduled
   tasks and a local-CLI SDK, but no externally triggerable API surface on
   subscription auth — in-app automations cannot be fired by external systems,
   `@codex` does not trigger on GitHub issues, and OpenAI's own CI/CD guidance
   makes headless use API-key-billed in practice. Claude cloud routines cap at
   15 runs/day on Max, live outside IaC in a personal account, and their push
   API is experimental without idempotency. `anthropics/claude-code-action@v1`
   officially supports Max-subscription OAuth (`claude setup-token`) in agent
   mode on `schedule`/`repository_dispatch`, and Sentry's MCP server runs
   headless over stdio with a static token.

## Decision

**Run Sentry triage/autofix as a staged pipeline inside GitHub Actions in this
repo, with GitHub Issues as the durable queue and Claude Code as the engine;
trust is earned in phases, and Codex remains the independent PR reviewer.**

- **Stage A — deterministic ingest (no LLM):** a scheduled script turns every
  new/regressed Sentry issue org-wide into exactly one labeled queue issue
  (`sentry-triage`), idempotent by Sentry short-ID. The queue reuses the
  ADR 0006 machinery for state, dedup, audit, and recovery — no bespoke DB.
  **This repo is public, so queue issues carry only non-sensitive coordinates**
  (short-ID, project, level, counts, timestamps, permalink) — never raw Sentry
  titles, culprits, messages, stack frames, or user data. Full payloads stay in
  Sentry and are fetched at triage time; noise heuristics run on the raw
  payload in-memory only, and only the resulting label is public.
- **Stage B — read-only agent triage:** per queue issue, a claude-code-action
  agent (Sentry MCP stdio, read-only token) posts a structured verdict comment
  (`code-fix` / `config-fix` / `upstream-transient` / `needs-human`).
  Sentry payloads are treated as untrusted input (prompt-injection surface):
  the investigating agent's only write is that comment — **verdict labels are
  applied by a deterministic workflow step** that parses the comment, validates
  it against the allowed label set, and rejects anything else, so the LLM
  session holds no queue-state authority. Verdict prose follows the same
  public-repo redaction rule (no verbatim payload text or user data).
- **Stage C — phased mutations:** Phase 2a: human-approved archive
  (`archived_until_escalating`, never hard-resolve) executed by a deterministic
  step with a separate write-scoped token. Phase 2b: scoped fix PRs in this
  repo via a GitHub App token (so required CI + Codex review actually fire),
  capped per run, `Fixes <SHORT-ID>` for release-linked resolution. Phase 3:
  cross-repo PRs after per-repo contract checks. Phase 4: push leg
  (internal-integration `issue.created` webhook → signature-verified relay →
  `repository_dispatch`) for fatal production issues only.
- **Observability is first-class:** every run leaves a durable run record on
  the tracker issue; failures surface via the existing scheduled-workflow
  Slack notifier; an independent staleness watcher (outside Actions) alerts
  when runs stop — the direct answer to the silent-routine incident.
- **Quota:** runs draw on the operator's Max subscription window with hard
  caps; the explicit revisit trigger is contention with interactive use, at
  which point the automation moves to API-key billing unchanged.

## Alternatives considered

- **Claude cloud routines as the backbone** — rejected: config lives in a
  personal claude.ai account outside IaC and review; "green run" ≠ task
  success with no audit trail (demonstrated by the failed experiment); 15
  runs/day cap; experimental non-idempotent push API. Routines stay in use for
  one-off post-deploy checks.
- **Sentry Seer / Seer→agent handoffs** — rejected: tried and disliked;
  per-active-contributor pricing; its auto-trigger gate (≥10 events/14d +
  fixability) is copied as a _prioritization_ input instead.
- **OpenClaw as scheduler/webhook layer** — rejected for unattended org
  automation: its coding-agent path runs unsandboxed on the host, the security
  model is explicitly single-operator, and its subscription reuse is only
  informally tolerated by Anthropic.
- **Codex as the automation engine** — rejected: no API surface for
  subscription-powered scheduled work (verified). Codex stays the
  independent-family reviewer of every agent PR, which strengthens the
  pipeline instead.
- **Push-based-first architecture** — deferred: at 4-5 new issues/day a 2×/day
  batch matches the practical latency need without a webhook relay's security
  and idempotency surface.
- **Fix-first (no triage stage)** — rejected: with ~60% noise, unconditional
  fix attempts burn quota on unfixable issues and spam PRs; prior art
  (including OpenAI's own triage guidance) starts read-only.

## Consequences

- New scheduled workflows are advisory, never required checks (ADR 0010), and
  are inert until Terraform-provisioned secrets exist and the
  `SENTRY_TRIAGE_ENABLED` variable is flipped (kill switch, ADR 0030).
- Automation may only ever set Sentry issues to `archived_until_escalating` —
  escalation resurfaces mistakes; hard-resolve stays human.
- The queue label namespace (`sentry-triage`, `sentry:*`) is disjoint from the
  dev-backlog labels (`agent-ready` etc.) so the two agent queues cannot
  cross-claim.
- Accepted residual risk: agent-authored verdict prose is instructed, not
  mechanically guaranteed, to stay redacted. A leaked-or-wrong verdict cannot
  merge code or mutate Sentry by itself — archiving requires a human-applied
  approval label, and merge stays human everywhere — but in Phase 2b a
  `code-fix` verdict does trigger automated branch/PR creation (bounded by
  per-run caps and the review gauntlet); that mutation is accepted, not
  human-pre-gated. A private queue repo was considered and rejected while
  redacted coordinates suffice — revisit if redaction proves leaky in practice.
- Verdict accuracy is measured from day one; each phase gates on the previous
  phase's measured performance, not on elapsed time.
- The prior weekly cloud routine is superseded and gets disabled at Phase-1
  activation.

## Evidence

- Research + adversarial verification session 2026-07-15 (platform claims
  re-verified against primary sources; two independent critiques folded in).
- Tracker issue [#1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282)
  (phases, child issues #1274-#1281; noise-floor work
  mento-protocol/frontend-monorepo#529).
- Phase-1 enforcement lands via sibling PRs in the same batch — #1287
  (`scripts/sentry-triage-ingest.mjs`, `.github/workflows/sentry-triage-ingest.yml`),
  #1286 (`.github/workflows/sentry-triage-agent.yml`, `.github/prompts/sentry-triage.md`),
  and #1284 (`terraform/github-secrets.tf`) — plus
  `docs/notes/sentry-triage-pipeline.md` (queue + verdict contracts, runbook).
  Until those merge, this ADR records the accepted plan those PRs implement.
