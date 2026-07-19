---
title: Documentation gardening runs through one bounded issue queue
status: active
owner: eng
canonical: true
last_verified: 2026-07-19
scope: ci/process
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0039 — Documentation gardening runs through one bounded issue queue

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
  structural markers identify the queue item and its week serial plus
  lane/shard fingerprint; queue labels are never used as the identity because
  claiming deliberately changes them.
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
- The workflow has only `contents: read` and `issues: write`, a default-branch
  guard, pinned actions, one non-cancelling concurrency group, and Slack failure
  notification coverage. It cannot write repository content, open or merge a
  PR, deploy, or mutate production.
- The repo-tracked `doc-garden` skill defines the human/agent semantic-review
  procedure. Evidence, a claimed issue, a normal reviewed PR, link repair, and
  catalog verification remain required before documentation changes land.

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
