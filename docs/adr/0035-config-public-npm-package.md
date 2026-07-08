---
title: shared-config publishes as the public @mento-protocol/config package
status: active
owner: eng
canonical: true
last_verified: 2026-07-08
scope: shared-config
date: 2026-07
---

# ADR 0035 — `shared-config` publishes as public `@mento-protocol/config`

**Status:** Accepted (Jul 2026), in force.
**Scope:** shared-config

## Context

ADR 0011 made `shared-config` the source of truth for Mento protocol metadata,
but its package name (`@mento-protocol/monitoring-config`) and private workspace
status made it look monitoring-specific and kept external consumers tied to this
repo boundary. The package contains public chain/token metadata, FX calendar
settings, thresholds, and ABIs; it does not contain secrets.

## Decision

Publish `shared-config/` to public npm as `@mento-protocol/config`. In-repo
consumers keep using `workspace:*`, while external consumers pin normal npm
versions. Releases are cut from `main` by pushing a `config-v<version>` tag that
matches `shared-config/package.json`; `.github/workflows/publish-config.yml`
builds on a GitHub-hosted runner, verifies the packed artifact, and publishes
with npm provenance via GitHub OIDC. Manual dispatches from `main` only validate
and pack the artifact; untagged workflow runs do not publish.

## Alternatives considered

- **Keep the private monitoring-specific package** — rejected: it preserves a
  misleading name and keeps non-monitoring consumers repo-bound.
- **Publish from a local maintainer machine** — rejected: manual publish state
  is harder to audit and bypasses the repository's build/pack verification.
- **Use a long-lived npm token secret** — rejected for the default path:
  trusted publishing avoids another manually managed secret and gives provenance.

## Consequences

- Package exports and `files` are now a public API; new entrypoints must ship
  both JavaScript and `.d.ts` files, and raw JSON assets must remain exported
  when consumers need the canonical data blobs.
- The publish workflow is part of the release contract and must stay covered by
  action pinning and pack-content verification.
- Manual workflow dispatch is a dry-run path only. Publishing must remain tied
  to a matching `config-v<version>` tag reachable from `origin/main`.
- Before the first publish tag is pushed, an npm org/package maintainer must
  configure trusted publishing for repository `mento-protocol/monitoring-monorepo`,
  workflow filename `publish-config.yml`, and allowed action `npm publish`.
- The publish job intentionally uses a GitHub-hosted runner because npm trusted
  publishing does not support self-hosted or third-party GitHub Actions runners.
- The public package intentionally keeps the workspace Node 24 engine floor for
  v0.1.x, matching `.node-version` and CI. Broadening support to older Node
  versions needs a package consumer and publish verification matrix.
- The indexer vendored mirror remains governed by ADR 0013 until a separate PR
  intentionally changes the hosted Envio dependency model.

## Evidence

- `shared-config/package.json`
- `.github/workflows/publish-config.yml`
- [`shared-config/AGENTS.md`](../../shared-config/AGENTS.md)
