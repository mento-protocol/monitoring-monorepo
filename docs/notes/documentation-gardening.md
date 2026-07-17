---
title: Documentation gardening
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: runbook
scope: ci/process
review_interval_days: 90
garden_lane: operator-runbooks
---

# Documentation gardening

The documentation garden keeps repository context navigable without treating
age as evidence that a document is wrong. The generated
[`docs/README.md`](../README.md) is the inventory and authority map;
[`docs/context-standards.md`](../context-standards.md) remains the metadata and
placement contract.

## Six-lane cycle

Every unique document belongs to exactly one lane:

1. agent entry points;
2. operator runbooks;
3. PR checklists and process;
4. ADRs and architecture;
5. package READMEs and reference;
6. notes, plans, and archive.

`pnpm docs:audit --dry-run` deterministically selects one lane each week.
UTC weeks start on Monday. After all six lanes have been selected, the next
rotation advances to the next shard within that lane. The rule uses only the
date and current catalog, so it needs no mutable cursor file. If the selected
lane currently has no documents, the planner emits a no-op packet instead of
failing CI or requiring placeholder documentation.

Each shard contains at most 10 documents and 15,000 source words. A document
that exceeds 15,000 words forms a singleton shard. Use explicit selection when
replaying or investigating a packet:

```bash
pnpm docs:audit --date 2026-07-20 --lane operator-runbooks --shard 1
pnpm docs:audit --lane adrs-architecture --shard 2 --format json
```

The packet records authority, lifecycle, ownership, size, inbound links,
content-change dates, broken links, metadata gaps, orphan signals, and likely
version references. These are triage signals, not semantic conclusions.

## Review contract

Every document receives one evidence-backed disposition: **Keep**,
**Tighten**, **Merge**, **Update**, **Supersede**, **Archive**, **Delete**, or
**Needs owner decision**.

- Never delete or demote a document because it is old.
- Never bump `last_verified` without checking the document against its owning
  code, workflow, provider contract, or current canonical source.
- Preserve architectural history in ADRs. Supersede an accepted ADR rather
  than rewriting its decision history.
- Repair inbound navigation when merging, moving, archiving, or deleting.
- Escalate unclear ownership or contradictory canonical sources instead of
  choosing silently.
- The planner is read-only. Semantic edits use a claimed GitHub issue and a
  normal reviewed PR.

Run `pnpm docs:index --check` after a gardening batch. If classification changed,
regenerate the catalog with `pnpm docs:index --write` and review the generated
diff before committing it.
