---
title: Shared Config Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-08
---

# AGENTS.md — Shared Config

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `shared-config`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

## Scope

`shared-config/` publishes as `@mento-protocol/config` and is the source of truth for chain metadata, deployment namespaces, token/pool label derivation, FX calendar data, thresholds, and shared ABIs.

## Operating Rules

- Add or change config data with a cross-reference test.
- Keep exported modules stable for all consumers; dashboard, indexer, bridge, and integration-probes typechecks are part of the change surface.
- If `fx-calendar.json` changes, verify trading-seconds assumptions in both dashboard and indexer code paths.
- Do not hand-edit `dist/` as the source of truth. Update `src/` or JSON inputs, then run the package build.
- Avoid importing runtime-heavy packages here. `shared-config` is consumed by client bundle code and should stay low-dependency.
- Public npm releases are tag-driven through `.github/workflows/publish-config.yml`; publish tags must be `config-v<shared-config/package.json version>` and point at `main`. Before the first publish tag, an npm org/package maintainer must configure trusted publishing for GitHub Actions with workflow filename `publish-config.yml`, allowed action `npm publish`, repository `mento-protocol/monitoring-monorepo`. Keep the publish job on GitHub-hosted runners because npm trusted publishing does not support self-hosted or third-party runners.

## Verification

Run `@mento-protocol/config` lint, typecheck, test, and build, then typecheck consumers when exported shapes change.
