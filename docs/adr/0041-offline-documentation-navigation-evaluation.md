---
title: Documentation navigation is evaluated offline with deterministic scoring
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: ci/process
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0041 — Documentation navigation is evaluated offline with deterministic scoring

**Status:** Accepted (Jul 2026), in force.
**Scope:** ci/process

## Context

The generated catalog, context budgets, and bounded garden planner can prove
that documentation is indexed and mechanically valid. They do not prove that a
fresh agent can route a real question to current authority, avoid archived
plans, cite evidence, or do so without loading an excessive amount of context.

Running a hosted model unattended in CI would introduce a model credential,
non-deterministic required checks, recurring cost, and an automation path whose
failure could be mistaken for a documentation regression. Letting the same
agent see expected routes would make the score meaningless.

## Decision

Use a versioned, offline evaluation contract:

- A bounded suite contains 15–20 representative questions and canonical
  accepted routes. Historical or non-canonical distractors name the canonical
  sources required to verify them.
- Prompt generation exposes questions and the structured result contract but
  never exposes accepted routes, qualification traps, or the baseline.
- A fresh, manually invoked, read-only agent reports ordered chosen documents,
  answers, targeted line evidence, authority qualifications, and every loaded
  source's exact bytes and hash.
- A deterministic local scorer recomputes routing accuracy, authority
  compliance, evidence coverage, shortest useful path, and context bytes. The
  initial pass contract is at least 90% routing accuracy, zero unqualified
  non-canonical reliance, complete evidence for every chosen document, and no
  context-budget breach. Evidence coverage is independent of whether the
  chosen document order matches an accepted route, so the 90% routing target
  is not silently tightened to 100% by the evidence target.
- Prompt generation requires a clean checkout, and the scorer reads source
  blobs from the result's claimed commit. A committed result names a commit
  reachable from the default branch in a full-history checkout. The contract
  may land first and the result follow from merged `main`; for a pre-change
  baseline in the same squash PR, the prompt pins the fetched `origin/main`
  ancestor instead of an intermediate branch commit.
- CI runs only fixture, validator, scorer, and issue-synchronizer tests. It
  never holds a model secret or invokes a model.
- The serialized `Documentation Garden` workflow creates at most one separate
  monthly evaluation issue using structural month and fixture-digest markers.
  The issue is a claimable reminder and routing-change report, not an agent
  invocation. It reuses the workflow's default-branch guard, minimal issue-only
  permissions, non-cancelling concurrency, and OIDC-bound live mutation check.
  Marker text is recognized only when the issue also carries the durable,
  workflow/maintainer-owned `source:audit` label.
- Routine runs use the cheapest capable read-only model. Failed or ambiguous
  cases alone escalate to stronger reasoning; proposed route changes receive
  independent high-effort review.
- Commit one pre-garden baseline before issues #1348–#1353 and a comparable
  post-garden result after all six lanes complete.

## Alternatives considered

- **Run a model as a required CI check** — rejected because model availability,
  latency, cost, and output variance are not deterministic merge gates, and a
  repository secret would expand the trust boundary.
- **Ask the weekly garden agent to judge navigation informally** — rejected
  because results would not be comparable across time and the agent would know
  too much about the packet it just edited.
- **Score answer text with expected phrases** — rejected because wording is
  brittle and encourages fixture gaming. Canonical route and line evidence are
  durable, reviewable signals.
- **Load the whole documentation corpus and ask general questions** — rejected
  because it measures recall inside a preloaded context rather than navigation
  quality or context efficiency.

## Consequences

- Navigation regressions become reproducible evidence instead of anecdotes.
- Model use remains explicit, local, read-only, and cost-tiered.
- Deterministic CI can protect the contract without treating stochastic model
  output as a required check.
- The scorer can prove routing and evidence discipline, but a human or stronger
  reviewer still judges contested semantic answers and proposed route changes.

## Evidence

- `docs/evals/documentation-navigation.md`
- `docs/evals/documentation-navigation-fixtures.json`
- `docs/evals/documentation-navigation-result.schema.json`
- `docs/evals/documentation-navigation-baseline.json`
- `scripts/docs-navigation-eval.mjs`
- `scripts/docs-navigation-eval-helpers.mjs`
- `scripts/docs-navigation-eval-result.mjs`
- `scripts/docs-navigation-eval.test.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/documentation-garden.yml`
