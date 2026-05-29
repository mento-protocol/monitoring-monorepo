# Backlog

GitHub Issues are the canonical active-work queue for agent-addressable work.
Use this query for ready items:

```text
is:issue is:open label:agent-ready -label:agent-active -label:in-pr
```

This file is transition storage for backlog items that have not yet been
migrated. It is currently **empty** — as of 2026-05-29 every tracked item is
either shipped, a GitHub Issue, or a `docs/notes/` record (see below). Append
here only for an item that genuinely has nowhere else to live yet; migrate it to
an Issue promptly.

- Active work → GitHub Issues (`source:backlog` label; priorities `priority:p1/p2/p3`).
- Decisions recorded so they aren't re-litigated → `docs/notes/terraform-cicd-hardening-decisions-2026-05.md`.
- Passive watch lists / parked ideas → `docs/notes/file-size-watch.md`, `docs/notes/indexer-spec-followups.md`.
- Speculative future sinks (Streamlit, ClickHouse) → `docs/ROADMAP.md`.

Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`, or
tests. Workflow details live in `docs/notes/agent-issue-workflow.md`.
