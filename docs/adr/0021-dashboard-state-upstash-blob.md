---
title: Dashboard mutable state lives in Upstash Redis with Vercel Blob backups
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: ui-dashboard
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0021 — Dashboard mutable state lives in Upstash Redis with Vercel Blob backups

**Status:** Accepted (Mar 2026; forensic reports May 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard has first-party mutable state that the indexer does not own: the
address book (wallet → label), long-form forensic reports, and bounded
address/entity intelligence records. This document-shaped state must survive
project recreation on a serverless (Vercel) runtime.

## Decision

Store this state in **Upstash Redis** and back up the seven managed hashes
(`labels`, `reports`, and five `intel_*` hashes) **daily to Vercel Blob** via a
`03:00 UTC` cron defined in `ui-dashboard/vercel.json`. Backup/restore use
Vercel Blob OIDC through the project-linked store — no static
`BLOB_READ_WRITE_TOKEN`. There is no relational database.

## Alternatives considered

- **A managed Postgres/relational DB** — rejected: overkill for low-volume
  document-shaped records; adds a stateful dependency and ops surface to a
  serverless app.
- **Put it in the indexer's Postgres** — rejected: this is first-party dashboard
  state, not indexed on-chain data; mixing them couples unrelated lifecycles.

## Consequences

- The Blob store is a **team-level** resource so it survives project recreation.
  Current backups write a private v2 manifest plus one blob per managed hash;
  legacy monolithic v1 blobs remain restore-only.
- This is a scoped address-book and intelligence backup, not a whole-Redis
  snapshot. Minipay sync state and TTL integration-probe snapshots remain
  outside it.
- The user-facing export/import shape still carries `addresses` + `reports`.
  Authenticated report editing uses the versioned `/api/address-reports` path.

## Evidence

- Address book + Upstash + Terraform `0b4908d5` (2026-03-06);
  forensic-report tab PR #330 (2026-05-07).
- Current hash and manifest contract in
  [`ui-dashboard/src/lib/address-labels/backup-format.ts`](../../ui-dashboard/src/lib/address-labels/backup-format.ts);
  operator detail in [`docs/deployment.md`](../deployment.md) §Address Book &
  Backup Cron.
