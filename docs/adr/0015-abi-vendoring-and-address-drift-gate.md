---
title: Vendor ABIs from the contracts package and gate indexed config addresses on a drift check
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: indexer-envio
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0015 — Vendor ABIs from the contracts package; gate indexed config addresses on a drift check

**Status:** Accepted (May 2026), in force.
**Scope:** indexer-envio

## Context

Envio config YAML hard-codes contract addresses and the handlers need ABIs. If a
config address silently stops matching `@mento-protocol/contracts` (a rename, a
redeploy, a typo), the indexer indexes the wrong thing and the failure is invisible
until data looks wrong downstream.

## Decision

**Vendor an explicit ABI allowlist** from `@mento-protocol/contracts` with
`pnpm --filter @mento-protocol/indexer-envio generate:abis`; keep the
generator header's listed exceptions hand-managed. Gate each per-chain
`chains[].contracts[].address` value in matched `config*.yaml` files with
`scripts/checkYamlAddresses.mjs`: each must resolve to
`@mento-protocol/contracts`, `config/nttAddresses.json`, or an explicit inline
allowlist. CI runs the check before codegen.

## Alternatives considered

- **Hand-maintain ABIs and addresses** — rejected: drifts from the published
  contracts package; the bug is silent.
- **Trust the contracts package at runtime only** — rejected: a drift check that
  runs in <1s at build time catches renames before they ship.

## Consequences

- To bump `@mento-protocol/contracts`, update the dependency, install it,
  regenerate ABIs, run
  `pnpm --filter @mento-protocol/indexer-envio check:yaml-addresses`, then run
  codegen and the mapped typechecks.
- Every ABI omitted from the generator's allowlist remains hand-managed and is
  documented in the generator header.

## Evidence

- ABI generator PR #247 and YAML address drift check PR #486;
  `scripts/generateAbis.mjs` and `scripts/checkYamlAddresses.mjs`.
- [`indexer-envio/AGENTS.md`](../../indexer-envio/AGENTS.md) §Key Files.
