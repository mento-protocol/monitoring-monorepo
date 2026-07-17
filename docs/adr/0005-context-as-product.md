---
title: Context is product — canonical authority model with a metadata contract
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: repo-wide
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0005 — Context is product: canonical authority model with a metadata contract

**Status:** Accepted (Jul 2026; roots from Mar 2026 AGENTS hierarchy), in force.
**Scope:** repo-wide (ci/process)

## Context

This repo is built and operated largely by agents. Their instructions (AGENTS.md,
SPEC, checklists, notes, plans) accumulated fast and started to contradict each
other. An agent that follows a stale plan as if it were current truth ships the
wrong thing. We needed an explicit rule for which documents are binding and which
are just history.

## Decision

Treat context as part of the product with a two-tier **authority model**:
**canonical** context (AGENTS.md files, SPEC.md, PR checklists, deployment docs,
skills/roles) is current operating truth; **non-canonical** context (PLANs, notes,
archived docs, backlog) is history that must be re-verified before acting. Managed
files carry metadata (`title`, `status`, `owner`, `canonical`, `last_verified`),
and `pnpm agent:context-check` enforces the contract, including a 90-day
staleness window on canonical files.

## Alternatives considered

- **Flat docs, trust-by-recency** — rejected: agents can't reliably tell a live
  runbook from an abandoned plan; recency lies after a revert.
- **Delete all historical docs** — rejected: rationale and intent are valuable; the
  fix is labeling authority, not erasing history.

## Consequences

- These ADRs are canonical context and are enrolled in the staleness check — that
  enrollment is the "is this still true?" enforcement.
- New canonical files are auto-discovered by `canonical: true` frontmatter in the
  discovery roots (root/nested `AGENTS.md`, `SPEC.md`, `docs/**`, `.agents/**`).
  Root `README.md` uses the same metadata keys in a hidden `agent-context`
  comment so the GitHub landing page does not render YAML frontmatter.
- Root `AGENTS.md` is kept lean; detail lives in the most specific owning file.

## Evidence

- [`docs/context-standards.md`](../context-standards.md); enforcement in `scripts/check-agent-context.mjs`.
- PR #1079 (SPEC under the authority model), PR #1090 (root AGENTS token diet), PR #1088 (archive completed PLANs).
