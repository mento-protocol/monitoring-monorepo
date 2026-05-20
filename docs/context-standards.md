---
title: Agent Context Standards
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# Agent Context Standards

This repo treats context as part of the product. Source code is what runs in production; context is what agents use to decide how to change it.

## Authority Map

### Canonical Context

Canonical context describes the system and operating rules as they are today. Agents may rely on it when making implementation decisions.

- `AGENTS.md` and nested `*/AGENTS.md` files: operational instructions scoped to the repo or a directory.
- `docs/pr-checklists/*.md`: mandatory review checklists for known hazard classes.
- `docs/deployment.md`: current deployment workflow.
- `.agents/skills/**/SKILL.md`: reusable agent procedures.
- `.agents/roles/*.md`: opt-in role definitions for verification and standards review.
- Package READMEs when they describe current commands or runtime behavior.

Canonical context must stay internally consistent. If two canonical files conflict, fix the conflict before relying on either one.

### Non-Canonical Context

Non-canonical context is useful history, intent, notes, or hypotheses. Agents may read it for rationale, but must verify current behavior in code, config, deployment state, or canonical docs before acting.

- `docs/PLAN-*.md`
- `docs/notes/*.md`
- archived docs
- roadmap/backlog entries
- historical PR review notes

Non-canonical context is allowed to be stale or contradictory. It should not be copied into canonical files without re-verification.

## Metadata Contract

Managed context files use YAML frontmatter with `title`, `status`, `owner`, `canonical`, and `last_verified` for canonical files.

Rules:

- `canonical: true` means the file is current operating truth.
- `canonical: false` means the file is history, intent, or notes.
- `owner` is the accountable reviewer for future cleanup.
- `last_verified` is required for canonical files whose correctness depends on external systems or current repo structure.

## Placement Rules

- Put instructions at the most specific directory that fully owns them.
- Move instructions upward only when multiple directories genuinely need them.
- Put repeatable procedures in `.agents/skills`, not in long root prose.
- Put verification personas in `.agents/roles`; roles are opt-in and do not run automatically.
- Keep root `AGENTS.md` small enough that every line earns its default-token cost.

## Maintenance Checks

Run `pnpm agent:context-check` to verify managed metadata, scoped AGENTS coverage, skill mirrors, and Cloud Run revision suffix guardrails.
