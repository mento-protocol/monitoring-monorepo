# Codex Cloud Setup and Maintenance

Codex Cloud does not inherit a developer's local `~/.agents`, `~/.codex`, or
`~/.claude` directories. Cloud setup and maintenance therefore rely on the
repo-local helper at `scripts/agent-autoreview.mjs`; they fail fast only if that
repo-owned executable is missing or an explicit `AUTOREVIEW_HELPER` override is
not executable. PR shipping requires `pnpm agent:autoreview` as the structured
batch-boundary review.
Configure the Codex Cloud environment setup script as:

```bash
./scripts/codex-cloud-setup.sh
```

Configure the optional Codex Cloud environment maintenance script as:

```bash
./scripts/codex-cloud-maintenance.sh
```

Codex Cloud setup expects `GH_TOKEN` (preferred) or `GITHUB_TOKEN` for GitHub
CLI-backed PR workflows, installs GitHub CLI from the official apt repository if
the base image lacks it, configures git to use `gh` credentials for fetch/push,
and refreshes `origin/main` before agent work starts. It also
prewarms the pinned Trunk CLI and runs `./tools/trunk install` so
Trunk-managed linters/runtimes are available before a task starts. If the cloud
proxy blocks Trunk, allowlist
`https://trunk.io/releases/`; if direct egress is available but the proxy is the
blocker, set `CODEX_CLOUD_TRUNK_BYPASS_PROXY=1` to add `trunk.io` to `NO_PROXY`
during setup. If neither route is available, set `CODEX_CLOUD_TRUNK_TARBALL_URL`
to a reachable mirror of the pinned Linux Trunk tarball and set
`CODEX_CLOUD_TRUNK_TARBALL_SHA256` so setup verifies the mirrored artifact before
installing it. Keep `CODEX_CLOUD_TRUNK_INSTALL_TOOLS=true` (the default) for
normal Cloud runs; set it to `false` only when using a base image with a
prewarmed Trunk cache. Setup also installs Foundry by default
(`CODEX_CLOUD_INSTALL_FOUNDRY=true`) so Aegis `forge test` checks can run. Set
`CODEX_CLOUD_FOUNDRYUP_URL` to use a mirrored installer and
`CODEX_CLOUD_FOUNDRYUP_SHA256` to verify that mirrored installer before
execution. Setup checks OSV API egress by POSTing to
`https://api.osv.dev/v1/querybatch` unless `CODEX_CLOUD_CHECK_OSV_EGRESS=false`,
and verifies the repo-local autoreview helper at
`scripts/agent-autoreview.mjs` before tool prewarm. Set `AUTOREVIEW_HELPER` only
for an intentional executable override; setup fails fast when the effective
helper is missing.

Codex Cloud maintenance runs when Codex resumes a cached container after
checking out the task branch. It skips apt/tool installation, re-establishes
repo-local git state, refreshes `origin/main`, verifies that the repo-local
autoreview helper is still present, syncs branch lockfile changes via
`CI=true pnpm install --frozen-lockfile --prefer-offline`, regenerates Envio
types, and runs `pnpm agent:context-check`.
