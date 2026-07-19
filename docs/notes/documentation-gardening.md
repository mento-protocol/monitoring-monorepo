---
title: Documentation gardening
status: active
owner: eng
canonical: true
last_verified: 2026-07-19
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

## Recurring issue queue

The `Documentation Garden` workflow runs at 08:47 UTC every Monday. It turns the
selected packet into one fully specified Agent Task linked to epic #1341. The
workflow owns only the issue envelope; `eng` owns the cadence and recovery
contract, while the eventual issue assignee owns semantic review and PR
closeout.

The queue is deliberately serialized:

- no live marked issue: create the selected occurrence as `agent-ready`;
- same occurrence still `agent-ready`: retain the immutable published packet
  without changing its title, body, or labels;
- planner scope drift before claim: preserve the issued scope and report a
  fail-closed no-op for manual review;
- live occurrence `agent-active` or `in-pr`: leave its scope unchanged;
- live occurrence `needs-grooming`: retain it as the one blocked packet until a
  human resolves or closes it;
- prior occurrence closed: advance to the next week serial and create the next
  bounded packet;
- multiple live markers or conflicting queue-state labels: fail closed for
  manual recovery;
- empty selected lane: report a no-op and create nothing.

Identity comes from the two leading `docs-garden-issue:v1` and
`docs-garden-packet:v1` markers. Do not remove or hand-copy them. Queue labels
cannot identify an occurrence because claiming intentionally moves
`agent-ready` to `agent-active` and then `in-pr`.

Use the CLI for a local or operator preview. Dry-run still reads the full issue
set and computes the exact decision but performs no label, issue, or repository
mutation. Live creation from a local CLI is rejected so it cannot race the
workflow's concurrency group:

```bash
pnpm docs:garden --dry-run --json
pnpm docs:garden --dry-run --date 2026-07-20 --lane adrs-architecture --shard 1 --json
```

For a live manual run, use the Actions `Documentation Garden` dispatch from the
default branch, first with its default `dry_run: true`. Review the reported
decision, then rerun with `dry_run: false`. Manual lane and shard values are
validated by Node and never interpolated into shell source.

If recovery is required, inspect every open issue with the leading marker.
Close a true duplicate or restore exactly one lifecycle label only after
confirming which issue owns the active work; preserve the markers and claimed
scope. Rerun a manual dry-run afterward. Scheduled failures are registered with
the main-branch Slack failure notifier.

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
- `docs:audit` is read-only. `docs:garden` may create only the GitHub issue
  envelope; once published, that envelope is immutable until closure. Semantic
  edits use a claimed issue and a normal reviewed PR.

Run `pnpm docs:index --check` after a gardening batch. If classification changed,
regenerate the catalog with `pnpm docs:index --write` and review the generated
diff before committing it.
