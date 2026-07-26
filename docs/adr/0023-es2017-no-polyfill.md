---
title: Transpile to ES2017; enforce an explicit browser API floor
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
scope: ui-dashboard
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0023 — Transpile to ES2017; enforce a browser API floor

**Status:** Accepted (May 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard's `tsconfig` targets `ES2017` and its TS `lib` includes newer
runtime API types. The transpilation target controls emitted syntax; it does not
define which built-in APIs supported browsers provide. Treating `ES2017` as
both contracts made the written policy reject APIs already used safely by the
client while lint blocked only three ES2023 array methods.

`arr.toSorted()` still compiles cleanly and throws `TypeError` on browsers in
the dashboard's support range. This bit PR #371 five times on `toSorted()`
sites.

## Decision

Keep the **ES2017 transpilation target without project-added polyfills for the
closed blocklist below**. Next.js still injects selected framework polyfills,
including `fetch`, `URL`, and `Object.assign`. Pin the Next.js 16 support floor
in `ui-dashboard/package.json`: Chrome 111+, Edge 111+, Firefox 111+, and Safari
16.4+. Client code may use APIs available across that floor, including
`Array.prototype.at`, `findLast`, `findLastIndex`, `flatMap`, and
`Promise.allSettled`.

ESLint blocks this closed set above the floor in client-shipped code:
`Array.prototype.toSorted`, `toReversed`, `toSpliced`, and `with`;
`TypedArray.prototype.toSorted`, `toReversed`, and `with`;
`Object.groupBy`, `Map.groupBy`, `String.prototype.isWellFormed`, and
`String.prototype.toWellFormed`. Its explicit ignore list owns server-only
routes, OG helpers, and tests. A regression test proves both the allowed and
blocked sets against the effective ESLint configuration.

The sanctioned reusable immutable sort is `sortedCopy(arr, cmp)` from
`@/lib/immutable-sort`, which centralizes the `[...arr].sort()` workaround and
its lint disable.

## Alternatives considered

- **Use the TypeScript target as the API policy** — rejected: it describes
  emitted syntax, and it would forbid APIs supported throughout the chosen
  browser range.
- **Raise the target or add `core-js`** — deferred: either change needs an
  explicit bundle-size and browser-support decision.
- **Fix sites ad hoc as they're flagged** — rejected: PR #371 proved this recurs; a
  lint rule + one helper stops the whole class.

## Consequences

- Reusable immutable-sort call sites should prefer `sortedCopy`; specialized
  copy-and-sort logic may stay local.
- Raising the transpilation target alone does not relax the API restriction.
  Change the browser floor or polyfill policy before changing the blocklist.
- If the floor rises to native immutable-array support, the restriction and
  the helper's react-doctor disable become cleanup candidates.

## Evidence

- `toSorted` flag origin PR #371; single immutable-sort helper PR #1092 (2026-07-05).
- Rule, exact lint allowlist, and regression coverage in
  [`ui-dashboard/eslint.config.mjs`](../../ui-dashboard/eslint.config.mjs);
  runtime policy in
  [`ui-dashboard/AGENTS.md`](../../ui-dashboard/AGENTS.md) §Browser target.
- Next.js 16 browser support:
  <https://nextjs.org/docs/architecture/supported-browsers>.
