---
title: Documentation gardening runs through one bounded issue queue
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

# ADR 0040 — Documentation gardening runs through one bounded issue queue

**Status:** Accepted (Jul 2026), in force.
**Scope:** ci/process

## Context

The repository has a deterministic documentation inventory and a six-lane,
bounded audit planner, but a planner that someone must remember to run does not
create a recurring gardening habit. Directly letting a scheduled agent rewrite
documentation would be too broad: freshness signals are not semantic evidence,
the repository's full documentation set exceeds a useful review context, and a
partially failed autonomous edit could silently remove operating knowledge.

The active-work source of truth is already GitHub Issues (ADR 0006). A recurring
process therefore needs to feed that queue without creating an ever-growing
duplicate backlog or changing the scope of work after an agent claims it.

## Decision

Run the documentation garden through a deterministic, issue-only scheduler:

- `Documentation Garden` runs every Monday and supports guarded manual
  dispatches with lane, shard, and dry-run controls.
- The existing read-only planner supplies one packet of at most 10 documents or
  15,000 source words. No LLM or credential is involved in selection.
- The scheduler creates at most one live Agent Task issue. Two leading
  structural markers plus the durable `source:audit` ownership label identify
  garden issues and their week serial plus lane/shard fingerprint. Lifecycle
  labels do not identify occurrences because claiming deliberately changes them.
- A published issue is immutable whether it is `agent-ready`, `agent-active`,
  `in-pr`, or `needs-grooming`. Reruns retain it without changing its body,
  title, or labels; this removes the otherwise unavoidable race between a
  non-conditional GitHub issue update and an agent claim. A blocked
  `needs-grooming` occurrence remains the one live packet until a human resolves
  or closes it. A subsequent occurrence is opened only after the prior issue
  closes. Multiple live markers or conflicting state labels fail loudly for
  manual recovery.
- Every generated issue contains all Agent Task sections, the complete planner
  packet, epic #1341, exact routing/risk/priority labels, and the verification
  and non-goal contract needed for independent execution.
- The workflow's resource permissions are limited to `contents: read` and
  `issues: write`, with `id-token: write` used only for OIDC issuance. It has a
  default-branch guard, pinned actions, one non-cancelling concurrency group,
  and Slack failure notification coverage. Before a live create, the job
  requests a short-lived
  GitHub Actions OIDC identity from the runner-only HTTPS endpoint and validates
  its repository, workflow ref and SHA, event, ref, run ID, attempt, audience,
  issuer, and lifetime claims. This proves the create originates in the exact
  serialized workflow rather than trusting caller-controlled environment
  variables, so local invocations remain dry-run previews. `id-token: write`
  permits only OIDC token issuance; it grants no write access to a GitHub or
  cloud resource. The workflow cannot write repository content, open or merge
  a PR, deploy, or mutate production.
- The repo-tracked `doc-garden` skill defines the human/agent semantic-review
  procedure. Evidence, a claimed issue, a normal reviewed PR, link repair, and
  catalog verification remain required before documentation changes land.
- ADR 0041 adds a separate monthly documentation-navigation evaluation issue
  sync to the same workflow. That issue has its own identity and lifecycle and
  does not participate in this ADR's one-live-garden-packet queue.

## Alternatives considered

- **Let a scheduled LLM edit and merge documentation directly** — rejected.
  It combines semantic judgment, deletion, repository writes, and merge
  authority in an unattended job, while deterministic freshness signals cannot
  prove that prose is obsolete.
- **Create one issue every week regardless of queue state** — rejected. Slow
  gardening weeks would accumulate stale, overlapping packets and overload the
  active-work queue.
- **Create a permanent issue per lane or track a mutable cursor file** —
  rejected. Permanent issues obscure completion, while mutable cursor state
  adds recovery and concurrency failure modes. Week serials plus closed issue
  history provide the required durable progression.
- **Run one monthly full-repository review** — rejected. The context would be
  too large for a careful semantic pass and would concentrate maintenance into
  an easy-to-skip batch.

## Consequences

- Documentation gardening is visible, claimable work with a bounded review
  context and an explicit done condition.
- A delayed packet intentionally blocks later packets until it is completed or
  manually resolved; cadence does not outrank preserving claimed scope.
- GitHub Issues are the only scheduled mutation. Content pruning still happens
  through normal repository review and can be rejected or corrected before
  merge.
- Operators must resolve duplicate live markers or invalid queue-state labels
  before the scheduler proceeds; fail-closed recovery is preferable to silently
  duplicating or overwriting work.

## Evidence

- `.github/workflows/documentation-garden.yml`
- `scripts/docs-garden-issue.mjs`
- `scripts/docs-garden-issue-helpers.mjs`
- `scripts/docs-garden-issue.test.mjs`
- `.agents/skills/doc-garden/SKILL.md`
- `docs/notes/documentation-gardening.md`
