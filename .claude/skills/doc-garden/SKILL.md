---
name: doc-garden
description: "[repo-skill] Audit and prune one bounded monitoring-monorepo documentation packet with evidence-backed dispositions, link repair, catalog updates, and normal reviewed-PR closeout. Use when working a generated documentation-garden issue or when asked to garden, prune, consolidate, re-verify, or remove stale ADRs, runbooks, checklists, notes, package READMEs, or agent instructions."
title: Documentation Garden Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Documentation Garden

Garden one bounded packet without treating age or deterministic warnings as
semantic conclusions. The canonical policy, lanes, shard limits, and
dispositions live in `docs/notes/documentation-gardening.md`; read it before
editing.

The recurring planner derives the weekly packet from the UTC Monday week and
current catalog: it rotates across six lanes, advances that lane's shard on its
next rotation, and caps normal shards at 10 documents and 15,000 source words.
The generated issue freezes the selected lane, shard, fingerprint, and file
list for review.

## Establish The Packet

1. Read the generated issue and verify that its first lines contain the
   `docs-garden-issue:v1` and `docs-garden-packet:v1` markers. Confirm all
   eight Agent Task sections and the complete generated planner packet exist.
2. Claim the issue through `pnpm issue:claim` before semantic edits; in a
   Claude cloud session use the MCP workboard fallback in
   [`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md)
   (label transition, claim comment, `issue:board sync` handoff). Do not
   overwrite a packet already labeled `needs-grooming`, `agent-active`, or
   `in-pr`; it remains the one live packet until resolved or closed.
3. Reproduce the packet when needed:

```bash
pnpm docs:audit --dry-run --date <selected-for> --lane <lane> --shard <shard>
```

Compare its fingerprint and file list with the issue. Catalog drift can change
a shard before it is claimed; reconcile that explicitly instead of silently
dropping files. If no generated issue exists, use the current dry-run packet to
bound the audit and create or claim an Agent Task before editing.

## Audit Every Document

For every file in the packet:

1. Read the whole document and its owning code, workflow, provider contract,
   linked ADRs, and inbound navigation.
2. Choose exactly one disposition: Keep, Tighten, Merge, Update, Supersede,
   Archive, Delete, or Needs owner decision.
3. Record concrete evidence for that choice. A timestamp, age, orphan signal,
   version candidate, or metadata warning is a prompt to investigate, not proof.
4. Make only supported changes. Repair every affected inbound link or index
   when moving, merging, archiving, or deleting content.

Never:

- delete or demote documentation solely because it is old;
- bump `last_verified` without verifying the current owning source;
- rewrite an accepted ADR's history; add a superseding ADR instead;
- guess through contradictory canonical sources or unclear ownership;
- expand into unrelated cleanup, deployment, secrets, production mutation, or
  autonomous PR merge.

Escalate a genuine owner decision and leave the affected document unchanged.

## Verify And Close

Regenerate the catalog only when paths or classification changed, then run:

```bash
pnpm docs:index --write
pnpm docs:index --check
pnpm agent:context-check
pnpm agent:context-budget --strict
pnpm agent:quality-gate --run
```

Summarize the disposition and evidence for every packet file in the PR body.
Open a normal ready-for-review PR, use `Closes #<issue>` only when the entire
packet is complete, and follow the repository ship/readiness workflow through
review and merge.
