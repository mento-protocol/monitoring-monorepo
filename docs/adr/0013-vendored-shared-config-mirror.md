---
title: The indexer vendors a mirror of shared-config because Envio builds outside the workspace
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-03
---

# ADR 0013 — The indexer vendors a mirror of `shared-config`, not a workspace link

**Status:** Accepted (Mar 2026), in force.
**Scope:** indexer-envio

## Context

ADR 0011 makes `shared-config` the single source of truth, and every other package
imports it directly. The indexer cannot: **Envio's hosted builder compiles the
indexer outside the pnpm workspace**, so a `workspace:*` link to
`@mento-protocol/monitoring-config` is not resolvable at hosted build time.

## Decision

The indexer **vendors a copy** of the pieces it needs —
`config/deployment-namespaces.json` and the token-filter logic mirrored in
`src/feeToken.ts` (`buildKnownTokenMeta`) — rather than importing the workspace
package. This is a deliberate, documented mirror: when the source policy changes in
`shared-config`, both copies are updated in the same change.

## Alternatives considered

- **`workspace:*` import like everyone else** — rejected: breaks the Envio hosted
  build, which runs outside the workspace.
- **Bundle shared-config into the indexer at build** — rejected: adds a build step
  Envio's hosted pipeline doesn't run; the vendored JSON/TS is simpler and reviewable.

## Consequences

- This is the **one** sanctioned violation of "no duplication" (ADR 0011); it is
  called out as a mirror-not-debt so reviewers don't try to "DRY" it away.
- The indexer layers a stricter fee-token policy at its call site on top of the
  mirror; drift is a review hazard, so both sides move together.

## Evidence

- `indexer-envio/config/deployment-namespaces.json`, `src/feeToken.ts`, and the workspace-boundary note at `src/contractAddresses.ts:14-18`.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md) §Dependencies.
