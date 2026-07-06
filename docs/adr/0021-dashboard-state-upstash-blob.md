---
title: Dashboard mutable state lives in Upstash Redis with Vercel Blob backups
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ui-dashboard
date: 2026-03
---

# ADR 0021 — Dashboard mutable state lives in Upstash Redis with Vercel Blob backups

**Status:** Accepted (Mar 2026; forensic reports May 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard has a little first-party mutable state that the indexer does not own:
the address book (wallet → label) and long-form forensic reports attached to
addresses. It's low-volume key/value data that needs to survive project recreation,
on a serverless (Vercel) runtime.

## Decision

Store this state in **Upstash Redis** (`labels` and `reports` hashes) and back it up
**daily to Vercel Blob** via a `03:00 UTC` cron defined in `ui-dashboard/vercel.json`.
Backup/restore use Vercel Blob OIDC through the project-linked store — no static
`BLOB_READ_WRITE_TOKEN`. There is no relational database.

## Alternatives considered

- **A managed Postgres/relational DB** — rejected: overkill for two hashes; adds a
  stateful dependency and ops surface to a serverless app.
- **Put it in the indexer's Postgres** — rejected: this is first-party dashboard
  state, not indexed on-chain data; mixing them couples unrelated lifecycles.

## Consequences

- The Blob store is a **team-level** resource so it survives project recreation; the
  snapshot JSON carries `addresses` + `reports` side by side and doubles as the
  import shape.
- Forensic reports are pushed to the `reports` hash via management tooling, never
  round-tripped through copy-paste (they identify individuals).

## Evidence

- Address book + Upstash + Terraform `0b4908d5` (2026-03-06); forensic-report tab PR #330 (2026-05-07).
- Storage + backup detail in [`docs/deployment.md`](../deployment.md) §Address Book & Backup Cron; [`ui-dashboard/AGENTS.md`](../../ui-dashboard/AGENTS.md).
