---
title: Architecture Decision Records — when and how
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
doc_type: checklist
scope: repo-wide
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Architecture Decision Records — when and how

Architectural decisions are recorded as ADRs under [`docs/adr/`](../adr/README.md).
This checklist answers the two questions the ADR log depends on: **does this
change need an ADR, and if so how do I write one.** Read it when a PR touches an
architecturally significant surface (the quality gate and
`pnpm adr:check` will remind you).

## Does this change need an ADR?

Write an ADR when your change makes a decision that meets **all three** tests:

1. **It constrains future work** — someone could later do the opposite and be
   wrong, without realizing a decision was already made.
2. **There was a real alternative** — a road not taken, not the only option.
3. **The "why" is not obvious from the code** — reading the diff shows _what_,
   not _why this way_.

If all three hold, add an ADR **in the same PR that makes the decision**. Do not
defer it to a follow-up — the rationale is freshest now, and the next session
reads the ADR as ground truth.

**Not an ADR:** bug fixes, dependency bumps, one-off features, refactors that
change no direction, or anything a code comment at the site already fully
explains. When in doubt, prefer recording it — a thin ADR beats a silent
decision — but do not manufacture ADRs for non-decisions.

## Trigger surfaces (the gate watches these)

These changes almost always encode a decision. `pnpm adr:check` (and the agent
quality gate) flags them when no ADR accompanies the diff:

- **A new package/service** — a new top-level directory with its own
  `AGENTS.md` / `package.json`.
- **A new Terraform stack** — a new entry in `terraform.stacks.json`.
- **A new CI/deploy workflow** — a new file under `.github/workflows/` (a new
  required check, deploy path, or gate).

Other high-signal-but-not-auto-detected decisions: swapping a hosting platform
or datastore, adding an alert plane, changing the read/query model, changing the
deploy/promotion model, or introducing a repo-wide policy (a new gate,
supply-chain control, or context rule).

## How to write one

1. Copy the shape of a recent ADR (e.g. `docs/adr/0001-*.md`). Sections:
   **Status · Context · Decision · Alternatives considered · Consequences ·
   Evidence.**
2. Number it with the next free `NNNN` and a kebab-case title:
   `docs/adr/NNNN-short-title.md`.
3. Frontmatter follows the repo metadata contract (enforced by
   `pnpm agent:context-check`): `status: active` for an in-force decision
   (`archived` for a superseded one), `canonical: true`, `owner: eng`,
   `last_verified: <today>`, plus `scope:` and `date:`. **Do not** use
   `status: accepted` — that is not a valid contract status; put "Accepted" in
   the body's Status line instead.
4. Cite real evidence: the PR number(s) / commit(s) and the canonical file(s)
   that now enforce the decision.
5. Add a row to the matching scope group in
   [`docs/adr/README.md`](../adr/README.md).
6. Add or confirm the one-line `docs/adr/` pointer in the owning package's
   `AGENTS.md`.

## Superseding a decision

Do not silently rewrite an ADR when reality changes. Add a **new** ADR that makes
the new decision, then flip the old one to `status: archived` with a
`superseded_by: ADR-NNNN` line and a body note. History stays legible.

## When an ADR is genuinely not needed

If the gate flags a trigger surface but the change is not a decision (e.g. a new
workflow that only reformats logs, a stack-file reorder), that is fine — say so
on the PR's **"Architecture decision?"** line with a one-line reason. A
won't-record with a reason is complete; a silent skip is not.
