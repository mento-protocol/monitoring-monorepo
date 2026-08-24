---
title: Codex Cloud Setup and Maintenance
status: active
owner: eng
canonical: true
last_verified: 2026-08-24
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Codex Cloud Setup and Maintenance

Codex Cloud does not inherit a developer's local `~/.agents`, `~/.codex`, or
`~/.claude` directories. Configure the environment setup script and optional
cached-container maintenance script as:

```bash
./scripts/bootstrap/codex-cloud-setup.sh
./scripts/bootstrap/codex-cloud-maintenance.sh
```

## Setup contract

Setup prepares a fresh container. It:

- marks the checkout safe for Git, configures token-backed GitHub credentials,
  adds or rewrites `origin` to HTTPS when required, checks repository and pull
  request API reads, and proves branch write access with a temporary branch;
- refreshes `origin/main` and enables `.trunk/hooks`;
- activates the `packageManager` version from `package.json` through Corepack;
- verifies the repo-local autoreview helper, prewarms Trunk, installs Foundry,
  and checks OSV API egress;
- installs the frozen workspace dependencies and Playwright Chromium with its
  Linux host libraries; and
- regenerates and verifies Envio types, then runs `pnpm agent:context-check`.

Setup fails closed when required GitHub auth/fetch, helper, tool installation,
dependency installation, codegen, or context validation fails. It can modify
global Git credential configuration and the checkout's `origin` URL; use a
dedicated Cloud container rather than a developer workstation.

## GitHub and package tooling

Setup expects `GH_TOKEN` (preferred) or `GITHUB_TOKEN` with repository Contents
read/write and pull-request read/write access. If `gh` is absent on an
apt-based image, it first tries the configured apt sources and then adds the
official GitHub CLI repository as a fallback. It verifies `gh` auth before
configuring fetch/push credentials. Setup then reads the repository and pull
request APIs and creates and deletes a unique temporary branch. This final
probe fails early when a token can fetch but cannot publish commits.

Playwright uses `install --with-deps chromium` after workspace installation so
dashboard browser tests can launch in a fresh Linux image. Set
`CODEX_CLOUD_INSTALL_PLAYWRIGHT_DEPS=false` only when the base image already
provides Chromium and all host libraries.

## Required outbound access

The setup path needs HTTPS access to the hosts below when the corresponding
tool is not already present in the image or cache:

- `github.com` and `api.github.com` for Git transport and API capability probes;
- `cli.github.com` for the GitHub CLI apt fallback;
- `registry.npmjs.org` for workspace and tool packages;
- `trunk.io` plus GitHub release hosts for Trunk and its managed tools;
- `foundry.paradigm.xyz` plus GitHub release hosts for Foundry;
- `api.osv.dev` for the supply-chain egress probe; and
- Playwright's download hosts, including `cdn.playwright.dev`, for Chromium.

Configure these in the Cloud environment network policy. Do not add proxy
bypasses in the repository except for the existing explicit Trunk override.

The pinned Trunk CLI is prewarmed and `./tools/trunk install` supplies its
managed linters and runtimes. If the Cloud proxy blocks Trunk, allowlist
`https://trunk.io/releases/`; when direct egress works, set
`CODEX_CLOUD_TRUNK_BYPASS_PROXY=1` to add `trunk.io` to `NO_PROXY`. Otherwise,
set both `CODEX_CLOUD_TRUNK_TARBALL_URL` and
`CODEX_CLOUD_TRUNK_TARBALL_SHA256` to a reachable verified mirror. Keep
`CODEX_CLOUD_TRUNK_INSTALL_TOOLS=true` unless the image already has a prewarmed
Trunk cache.

Foundry installs by default so Aegis `forge test` checks can run. Set
`CODEX_CLOUD_INSTALL_FOUNDRY=false` only when the image already supplies it. A
custom `CODEX_CLOUD_FOUNDRYUP_URL` executes installer code, so pair it with a
`CODEX_CLOUD_FOUNDRYUP_SHA256` value that contains exactly 64 hexadecimal
characters. Setup rejects a missing or malformed custom checksum before it
downloads the installer. It downloads a custom installer to a temporary regular
file, verifies the checksum, runs it only after verification, and removes the
file after success or failure. The exact default URL,
`https://foundry.paradigm.xyz`, keeps Foundry's documented public installer
pipeline without a checksum.

Setup POSTs to `https://api.osv.dev/v1/querybatch` to prove osv-scanner egress.
Set `CODEX_CLOUD_CHECK_OSV_EGRESS=false` only when that check is intentionally
unavailable and the resulting quality-gate limitation is accepted.

## Autoreview helper

The default helper is `scripts/agent-autoreview.mjs`. Set `AUTOREVIEW_HELPER`
only for an intentional compatible executable override. The helper and
prepared-bundle trust contracts live in
[`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md); do not
duplicate them here.

## Maintenance contract

Maintenance runs after a cached container checks out the task branch. It skips
apt and tool installation, then re-establishes Git/origin state, refreshes
`origin/main`, enables repo hooks, activates pnpm, verifies the autoreview
helper, syncs the branch lockfile with:

```bash
CI=true pnpm install --frozen-lockfile --prefer-offline
```

It finishes by regenerating Envio types and running
`pnpm agent:context-check`.
