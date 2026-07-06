---
title: Hasura auto-generated GraphQL over Postgres is the read API
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: repo-wide
date: 2026-03
---

# ADR 0003 — Hasura auto-generated GraphQL over Postgres is the read API

**Status:** Accepted (Mar 2026), in force.
**Scope:** repo-wide (data access)

## Context

The indexer writes entities to Postgres; the dashboard, metrics-bridge, and
integration-probes all need to read them. We did not want to hand-build and
maintain a bespoke API layer over the indexer's tables.

## Decision

Read through the **Hasura GraphQL API that Envio auto-generates** over the
indexer's Postgres tables. All consumers query Hasura; there is no custom read
service between the database and the clients.

## Alternatives considered

- **A hand-written REST/GraphQL service** — rejected: duplicates schema knowledge
  the indexer already owns, and adds a service to run and keep in sync.
- **Clients query Postgres directly** — rejected: couples every client to DB
  credentials and physical schema, and loses Hasura's query shaping.

## Consequences

- The GraphQL schema is a generated artifact of the Envio schema — schema changes
  propagate straight to query and UI types (hence ADR 0008's cross-layer checklist).
- Hasura's `_aggregate` is available but deliberately **not** used for hot paths;
  we precompute snapshot entities instead (ADR 0014, ADR 0020).
- Verify production behavior via Hasura introspection, not the indexer CLI, because
  parallel deploys can prune a CLI-reported entry mid-serve.

## Evidence

- `257f08f1`, `b1169451` (2026-03-04) early Hasura wiring + unconfigured-URL handling.
- Endpoint + topology in [`SPEC.md`](../../SPEC.md); no-aggregate rule in [`docs/pr-checklists/swr-polling-hasura.md`](../pr-checklists/swr-polling-hasura.md).
