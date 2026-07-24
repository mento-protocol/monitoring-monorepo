---
title: Ship ES2017 with no polyfill; ban immutable-array methods via lint and sortedCopy
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: ui-dashboard
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0023 — Ship ES2017 with no polyfill; ban immutable-array methods

**Status:** Accepted (May 2026), in force.
**Scope:** ui-dashboard

## Context

The dashboard's `tsconfig` targets `ES2017` with no `browserslist` override and no
polyfill, but its TS `lib` includes ES2023+ type definitions. So `arr.toSorted()`
**compiles clean** and then throws `TypeError` at runtime on older Safari/Chrome/
Firefox. This bit PR #371 five times on `toSorted()` sites.

## Decision

Keep the **ES2017 target with no polyfill** and forbid newer runtime APIs in
client-shipped code. Package instructions list the unsafe API set. The
sanctioned reusable immutable sort is `sortedCopy(arr, cmp)` from
`@/lib/immutable-sort`, which centralizes the `[...arr].sort()` workaround and
its lint disable.

Current automated enforcement is narrower than that accepted policy: ESLint's
`no-restricted-properties` backstop bans `toSorted`, `toReversed`, and
`toSpliced` outside its explicit server/test allowlist. Aligning the wider
policy, lint rule, exception surface, and helper guidance is tracked in
[#1570](https://github.com/mento-protocol/monitoring-monorepo/issues/1570);
until then, review enforces the remaining package rule.

## Alternatives considered

- **Raise the target to ES2022+ or add `core-js`** — deferred, not rejected: it
  would let the ban relax, but it's a bundle-size + browser-support decision not yet
  made. Until then, the ban holds.
- **Fix sites ad hoc as they're flagged** — rejected: PR #371 proved this recurs; a
  lint rule + one helper stops the whole class.

## Consequences

- Reusable immutable-sort call sites should prefer `sortedCopy`; specialized
  copy-and-sort logic may stay local.
- If the target is ever raised, the ESLint restriction and the helper's react-doctor
  disable become cleanup candidates.

## Evidence

- `toSorted` flag origin PR #371; single immutable-sort helper PR #1092 (2026-07-05).
- Rule and exact lint allowlist in
  [`ui-dashboard/eslint.config.mjs`](../../ui-dashboard/eslint.config.mjs);
  wider safe/unsafe API policy in
  [`ui-dashboard/AGENTS.md`](../../ui-dashboard/AGENTS.md) §Browser target.
