---
title: Shared Config Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: agent-instructions
scope: shared-config
review_interval_days: 90
garden_lane: agent-entry-points
---

# AGENTS.md — Shared Config

Read the relevant [`docs/adr/`](../docs/adr/README.md) record before changing
the package build architecture.

## Scope

`shared-config/` publishes as `@mento-protocol/config`. It is the source of truth
for chain metadata, deployment namespaces, token/pool label derivation, FX
calendar data, thresholds, and shared ABIs.

## Operating Rules

- Use a cross-reference test for each config-data change.
- Keep exported modules stable. Dashboard, bridge, and integration-probes
  typechecks cover direct workspace consumers. The indexer uses checked-in
  mirrors of selected config.
- Keep the indexer mirrors of `aggregators.json`,
  `deployment-namespaces.json`, `fx-calendar.json`, and
  `oracle-reporters.json` in sync. After an FX calendar change, verify
  trading-seconds assumptions in dashboard and indexer code.
- Do not hand-edit `dist/`. Update `src/` or JSON inputs, then build. The build
  removes `dist/` before TypeScript emits current output.
- Avoid runtime-heavy dependencies; client bundles consume `shared-config`.
- Publish through `.github/workflows/publish-config.yml`. Tags must match
  `config-v<shared-config/package.json version>` and reference a commit reachable
  from `origin/main`. Manual `workflow_dispatch` validates and packs without
  publishing. Use a GitHub-hosted runner because npm trusted publishing does not
  support self-hosted or third-party runners.
- Node follows the root `.node-version` before 1.0. Do not lower it without a
  matching consumer and publish verification matrix.

## Verification

Run the direct package checks from step 3 of the
[PR operating card](../docs/notes/pr-operating-card.md). Also run
`pnpm --filter @mento-protocol/config build` before a direct consumer check so
the consumer loads current `dist/` output. Apply the dashboard bundle-input row
in step 3 to every `shared-config/**` change. Run its shared-config build,
dashboard build, and dashboard size-limit checks before review. Required CI
owns coverage, Knip, downstream consumer, and conditional indexer-mirror
coverage.
