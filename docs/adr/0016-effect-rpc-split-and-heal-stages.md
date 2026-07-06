---
title: Split effects and RPC from handlers; decompose upsertPool into pure heal-stages
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: indexer-envio
date: 2026-07
---

# ADR 0016 — Split effects/RPC from handlers; decompose `upsertPool` into pure heal-stages

**Status:** Accepted (evolved through 2026; heal-stage decomposition Jul 2026), in force.
**Scope:** indexer-envio

## Context

Handlers mix event decoding, RPC reads (for state a log doesn't carry), and entity
writes. Envio's `mockDb` can't observe multiple `set()` calls to the same id within
a single handler, so logic that heals pool state across several writes is hard to
test through the handler surface — and untested heal logic silently corrupts derived
state.

## Decision

Keep a **layer split** — RPC/effect primitives (the `rpc/` modules behind the
`rpc.ts` barrel) separated from event handlers — and decompose the pool-healing
path (`upsertPool`) into **named, pure heal-stage functions**. The heal logic is
tested as pure functions, not through `mockDb`.

## Alternatives considered

- **One monolithic handler with inline RPC** — rejected: untestable heal logic and
  tangled effect/decoding concerns.
- **Rely on `mockDb` integration tests** — rejected: `mockDb` can't see intra-handler
  multi-`set()`, so it gives false confidence on exactly the heal paths that matter.

## Consequences

- Derived-state correctness is covered by pure-function tests + targeted Stryker
  mutation baselines rather than brittle handler mocks.
- New RPC primitives go behind the `rpc.ts` barrel, not inline in handlers.

## Evidence

- `upsertPool` heal-stage decomposition PR #1094 (2026-07-05); `src/rpc/`, `src/rpc.ts`.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md).
