---
title: Native GraphQL transport and client-side Zod Mini for the dashboard
status: active
owner: eng
canonical: true
last_verified: 2026-07-15
scope: ui-dashboard
date: 2026-07
---

# ADR 0037 — Dashboard native GraphQL transport and client-side Zod Mini

**Status:** Accepted (Jul 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard used `graphql-request` only as a thin class-based POST wrapper:
one operation per request, two request call shapes, per-endpoint client reuse,
and structured error metadata for 429 `Retry-After` handling. Browser-reachable
response and environment schemas also imported full Zod even though their
validation features are supported by `zod/mini`. Together those dependencies
consumed bundle-budget headroom without providing batching, subscriptions, or
other client features.

Whether a schema affects the client bundle depends on import reachability, not
its directory. Server-only validation, including `server-env.ts` and the Redis
snapshot parser in `integration-probes.ts`, has no browser-size benefit from a
Zod Mini migration.

## Decision

Dashboard GraphQL requests use the internal native-fetch transport in
`ui-dashboard/src/lib/graphql-fetch.ts`. It preserves both existing request
forms, per-endpoint client reuse, `AbortSignal` forwarding, and a `ClientError`
response shape with status and headers for retry handling. It deliberately
keeps one operation per HTTP request; batching remains a separate decision.

Runtime schemas reachable from client components use `zod/mini` and its
functional composition API. Schemas that are server-only continue to use full
Zod, including the integration-probe snapshot parser. Shared consumers depend
on the structural `SafeParseSchema` contract instead of a full-Zod type so both
schema implementations remain accepted without widening browser imports.

## Alternatives considered

- **Keep `graphql-request`** — rejected: the dashboard did not use the broader
  library surface, and retaining it spent client bytes for a thin POST wrapper.
- **Adopt another GraphQL client** — rejected: Apollo, urql, and similar clients
  add cache and request-model concepts the current SWR polling read model does
  not need.
- **Keep full Zod in browser-reachable modules** — rejected: their schema
  feature set is Zod Mini-compatible, so full Zod adds avoidable client weight.
- **Move every schema to Zod Mini** — rejected: server-only modules gain no
  client-bundle savings, and converting their chained transforms adds churn
  without an operational benefit.

## Consequences

- New dashboard GraphQL call sites use `graphql-fetch.ts`; adding batching,
  subscriptions, uploads, or a richer GraphQL client requires revisiting this
  decision rather than silently growing the compatibility wrapper.
- Transport changes must preserve and test both request forms, abort behavior,
  structured GraphQL/HTTP failures, response headers, and endpoint reuse because
  callers rely on those semantics for polling and quota backoff.
- Schema-library choice follows the runtime import graph. Client-reachable
  validation uses `zod/mini`; server-only validation may use full Zod.
- Bundle savings remain protected by the aggregate client-JavaScript budget in
  `ui-dashboard/.size-limit.cjs`.

## Evidence

- [Issue #1249](https://github.com/mento-protocol/monitoring-monorepo/issues/1249)
- [PR #1285](https://github.com/mento-protocol/monitoring-monorepo/pull/1285)
- [`ui-dashboard/src/lib/graphql-fetch.ts`](../../ui-dashboard/src/lib/graphql-fetch.ts)
- [`ui-dashboard/src/lib/__tests__/graphql-fetch.test.ts`](../../ui-dashboard/src/lib/__tests__/graphql-fetch.test.ts)
- [`ui-dashboard/src/lib/safe-parse-schema.ts`](../../ui-dashboard/src/lib/safe-parse-schema.ts)
- [`ui-dashboard/.size-limit.cjs`](../../ui-dashboard/.size-limit.cjs)
