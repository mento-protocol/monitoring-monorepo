---
title: Split effects and RPC from handlers; decompose upsertPool into named effect-injected stages
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0016 — Split effects/RPC from handlers; decompose `upsertPool` into named effect-injected stages

**Status:** Accepted (evolved through 2026; heal-stage decomposition Jul 2026), in force.
**Scope:** indexer-envio

## Context

Handlers mix event decoding, RPC reads (for state a log doesn't carry), and entity
writes. Envio's `mockDb` can't observe multiple `set()` calls to the same id within
a single handler, so logic that heals pool state across several writes is hard to
test through the handler surface — and untested heal logic silently corrupts derived
state.

## Decision

Keep a **layer split**: put RPC/effect primitives in focused `rpc/` modules,
separate from event handlers, and reserve the `rpc.ts` barrel for compatibility
exports or a deliberate shared API. Decompose the pool-healing path
(`upsertPool`) into **named, effect-injected stages** that return healed values
or deltas without writing the `Pool` entity. Test those stages directly with
hermetic effect doubles rather than through `mockDb`; keep context-free merge
helpers pure.

## Alternatives considered

- **One monolithic handler with inline RPC** — rejected: untestable heal logic and
  tangled effect/decoding concerns.
- **Rely on `mockDb` integration tests** — rejected: `mockDb` can't see intra-handler
  multi-`set()`, so it gives false confidence on exactly the heal paths that matter.

## Consequences

- Derived-state correctness is covered by direct stage tests and pure-helper
  tests rather than brittle handler mocks. Mutation baselines apply only to the
  files selected by the current Stryker configuration.
- New RPC reads belong in focused effect modules, not inline in handlers.

## Evidence

- `upsertPool` stage decomposition PR #1094 (2026-07-05);
  `src/pool/upsert-stages.ts`, `src/pool/self-heal.ts`, `src/rpc/`, and
  `src/rpc.ts`.
- Direct coverage in `test/upsertPoolStages.test.ts` and
  `test/self-heal.test.ts`.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md).
