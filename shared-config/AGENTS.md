---
title: Shared Config Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: agent-instructions
scope: shared-config
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Shared Config

Read the relevant [`docs/adr/`](../docs/adr/README.md) record before changing
this package's build architecture.

## Scope

`shared-config/` publishes as `@mento-protocol/config` and is the source of truth for chain metadata, deployment namespaces, token/pool label derivation, FX calendar data, thresholds, and shared ABIs.

## Operating Rules

- Add or change config data with a cross-reference test.
- Keep exported modules stable for direct workspace consumers; dashboard, bridge,
  and integration-probes typechecks are part of the change surface. The indexer
  consumes checked-in mirrors of selected shared config.
- Keep the indexer's checked-in mirrors of `aggregators.json`,
  `deployment-namespaces.json`, `fx-calendar.json`, and
  `oracle-reporters.json` synchronized with this package. If the FX calendar
  changes, also verify trading-seconds assumptions in dashboard and indexer
  code paths.
- Do not hand-edit `dist/`. Update `src/` or JSON inputs, then build. The build
  removes `dist/` before TypeScript emits current output.
- Avoid runtime-heavy dependencies; client bundles consume `shared-config`.
- Public npm releases use `.github/workflows/publish-config.yml`. Tags must match
  `config-v<shared-config/package.json version>` and reference `origin/main`
  history. Manual `workflow_dispatch` validates and packs without publishing.
  Keep the publish job on GitHub-hosted runners; npm trusted publishing does
  not support self-hosted or third-party runners.
- The package's Node engine follows the repo `.node-version` throughout the pre-1.0 release line. Do not lower the engine floor without adding a matching consumer and publish verification matrix.

## Verification

Run `pnpm agent:quality-gate --run`. Its shared-config mapping covers lint,
typecheck, tests, coverage, knip, clean build, direct-consumer typechecks,
dashboard bundle size, and conditional indexer mirror checks. Consumer-only
mappings clean-build this package before loading its ignored `dist/` output.
