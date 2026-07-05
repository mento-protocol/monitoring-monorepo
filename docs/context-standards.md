---
title: Agent Context Standards
status: active
owner: eng
canonical: true
last_verified: 2026-07-05
---

# Agent Context Standards

This repo treats context as part of the product. Source code is what runs in production; context is what agents use to decide how to change it.

## Authority Map

### Canonical Context

Canonical context describes the system and operating rules as they are today. Agents may rely on it when making implementation decisions.

- `AGENTS.md` and nested `*/AGENTS.md` files: operational instructions scoped to the repo or a directory.
- `SPEC.md`: the technical specification of the monitoring system's architecture, data flow, and endpoints.
- `docs/pr-checklists/*.md`: mandatory review checklists for known hazard classes.
- `docs/deployment.md`: current deployment workflow.
- `.agents/skills/**/SKILL.md`: reusable agent procedures.
- `.agents/roles/*.md`: opt-in role definitions for verification and standards review.
- Package READMEs when they describe current commands or runtime behavior.

Canonical context must stay internally consistent. If two canonical files conflict, fix the conflict before relying on either one.

Root `README.md` is deliberately excluded from the metadata contract for now: it's a GitHub-rendered landing page, and a raw `---\nkey: value\n---` frontmatter block would render as literal text at the top of the repo homepage. Bringing it into `scripts/check-agent-context.mjs` would need a comment-based marker the check can parse instead — tracked in #1071 rather than built speculatively here.

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
- `pnpm agent:context-check` fails once a `canonical: true` file's `last_verified` is more than 90 days old. Re-verify the content and bump the date; don't extend the window to make the check pass.

## Placement Rules

- Put instructions at the most specific directory that fully owns them.
- Move instructions upward only when multiple directories genuinely need them.
- Put repeatable procedures in `.agents/skills`, not in long root prose.
- Put verification personas in `.agents/roles`; roles are opt-in and do not run automatically.
- Keep root `AGENTS.md` small enough that every line earns its default-token cost.

## Maintenance Checks

Run `pnpm agent:context-check` to verify managed metadata (including the `last_verified` staleness window), scoped AGENTS coverage, skill mirrors, and Cloud Run revision suffix guardrails. Skill mirrors must match their canonical `.agents/skills` source except for documented runtime-specific provenance literals, such as forensic-report writes using `source: "Codex"` in the Codex skill and `source: "claude"` in the Claude skill.
