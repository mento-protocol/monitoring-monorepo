#!/usr/bin/env bash
# Prepare a Claude Code on the web container for monitoring-monorepo agent work.
#
# Invoked from the SessionStart hook in .claude/settings.json (Claude Code on
# the web only, gated on $CLAUDE_CODE_REMOTE). Keeps the cloud checkout close
# to a fresh local worktree without requiring anything from a developer's home
# directory.
#
# Parallel to scripts/codex-cloud-setup.sh (Codex Cloud). The two scripts share
# the install/codegen contract; this one additionally installs Playwright
# Chromium so the browser-fixture tests under
# `pnpm --filter @mento-protocol/ui-dashboard test:browser` work without an
# extra step.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

echo "==> Configuring repository git hooks"
git config core.hooksPath .trunk/hooks

echo "==> Activating package manager from package.json"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
pnpm --version

echo "==> Prewarming Trunk CLI and linters"
# Trunk powers the git pre-commit/pre-push hooks (.trunk/hooks) and `trunk fmt`.
# The launcher self-downloads the pinned CLI from trunk.io, which is NOT in the
# default Trusted allowlist for Claude Code on the web. Everything else Trunk
# needs (node/python runtimes, prettier/markdownlint via npm, checkov/codespell/
# yamllint via PyPI, trufflehog/osv-scanner/actionlint via GitHub releases, tool
# binaries on *.amazonaws.com) is already covered by the Trusted defaults, so the
# ONLY host to add is trunk.io. In the environment's network settings choose
# "Custom", keep "include defaults", and add:
#     trunk.io
#     *.trunk.io
# Non-fatal: if trunk.io is still blocked the hooks degrade gracefully (see
# .trunk/hooks) and CI still enforces Trunk on the PR, so warn and continue
# rather than aborting the whole bootstrap.
if trunk_ver=$(TRUNK_LAUNCHER_QUIET=true ./tools/trunk --version 2>/dev/null); then
  echo "$trunk_ver"
  if ! ./tools/trunk install; then
    echo "WARN: 'trunk install' could not preinstall all linters; hooks may run a reduced set." >&2
  fi
else
  echo "WARN: Trunk CLI could not be downloaded (is trunk.io allowlisted?)." >&2
  echo "WARN: git pre-commit/pre-push hooks will be skipped this session." >&2
  echo "WARN: Add 'trunk.io' and '*.trunk.io' to the env's Allowed domains (Custom" >&2
  echo "WARN: network access, keep defaults) to enable local Trunk fmt/lint hooks." >&2
fi

echo "==> Installing workspace dependencies"
# Both the cached environment Setup script and the SessionStart hook re-enter
# this script on a fresh container, so skip the (~15s) reinstall when a previous
# bootstrap already installed deps for this exact lockfile. Any pnpm-lock.yaml
# change — or a wiped node_modules — busts the content marker and reinstalls.
# The marker lives inside the gitignored node_modules, so it is naturally
# discarded whenever the dependency tree is.
deps_marker="node_modules/.web-bootstrap-lock.sha256"
deps_hash="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
if [ -d node_modules ] && [ -f "$deps_marker" ] &&
  [ "$(cat "$deps_marker" 2>/dev/null)" = "$deps_hash" ]; then
  echo "deps already installed for this pnpm-lock.yaml; skipping pnpm install."
else
  CI=true pnpm install --frozen-lockfile
  printf '%s' "$deps_hash" >"$deps_marker"
fi

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

echo "==> Running Envio codegen"
# Skip the (~6s) regen when the type facade already exists for the current
# schema + config — the dominant inputs to the generated types. A change to
# either (or a missing facade) busts the marker and forces a clean regen. The
# marker lives in the gitignored .envio dir, so it is discarded with the facade.
codegen_marker="indexer-envio/.envio/.web-bootstrap-codegen.sha256"
codegen_hash="$(cat indexer-envio/schema.graphql indexer-envio/config.yaml | sha256sum | awk '{print $1}')"
if [ -s "indexer-envio/.envio/types.d.ts" ] && [ -f "$codegen_marker" ] &&
  [ "$(cat "$codegen_marker" 2>/dev/null)" = "$codegen_hash" ]; then
  echo "Envio types up to date for the current schema/config; skipping codegen."
else
  # Drop any stale type facade first: a reused/cached checkout may already carry
  # the gitignored .envio/types.d.ts, which would let the verification below pass
  # even if THIS codegen run silently wrote nothing — the exact miss we guard for.
  rm -f indexer-envio/.envio/types.d.ts
  pnpm indexer:codegen
fi

echo "==> Verifying Envio codegen output"
# `envio codegen` is quiet in CI/non-TTY mode and exits 0 even when it writes
# nothing, so the exit code alone is not a reliable signal. The agent typecheck
# and vitest loops resolve indexer types from .envio/types.d.ts (the `envio` npm
# package supplies the runtime); the ReScript `generated/` dir is only needed
# for `pnpm indexer:dev`/`start` (Docker + live RPC), which is not a hosted-agent
# flow. Assert the type facade exists so a silent codegen miss fails the
# bootstrap here instead of surfacing as confusing type errors mid-task.
if [ ! -s "indexer-envio/.envio/types.d.ts" ]; then
  cat >&2 <<'MSG'
error: Envio codegen did not produce indexer-envio/.envio/types.d.ts.
indexer typecheck and the vitest suites resolve types from this file and will
fail without it. Re-run 'pnpm indexer:codegen' and inspect the envio CLI
output for the underlying error.
MSG
  exit 1
fi
# Record the inputs that produced this verified facade so a later bootstrap with
# an unchanged schema/config can skip the regen above. Written only after the
# existence check passes, so the marker never caches a failed/empty codegen.
printf '%s' "$codegen_hash" >"$codegen_marker"

echo "==> Installing Playwright Chromium for dashboard browser tests"
# Non-fatal: hosted environments often restrict outbound network access
# (cdn.playwright.dev returns 403 "Host not in allowlist") or run without sudo
# (so `--with-deps` cannot install OS packages). Browser tests are optional for
# most agent flows; warn and continue so the rest of the bootstrap (codegen,
# context-check) still completes. `--with-deps` mirrors the repo CI workflows
# (`.github/workflows/ci.yml` and `update-snapshots.yml`) so a successful
# bootstrap leaves the container actually able to run the browser fixtures.
if ! pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium; then
  echo "WARN: Playwright Chromium install failed." >&2
  echo "WARN: 'pnpm --filter @mento-protocol/ui-dashboard test:browser' will not work" >&2
  echo "WARN: until the environment allows access to cdn.playwright.dev and can" >&2
  echo "WARN: install OS dependencies (sudo apt-get) for Chromium." >&2
fi

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "==> Configuring GitHub integration mode"
# In Claude Code on the web, git transport is proxied through a local credential
# proxy (origin is http://local_proxy@127.0.0.1:.../git/...) that authenticates
# git only, so no GitHub token is exposed in the container and `gh` has no
# credential by default. api.github.com itself IS reachable (it is in the default
# Trusted allowlist), so GitHub API work flows two ways: the GitHub MCP server
# (default, zero setup) or `gh` once a GH_TOKEN env var is set. We auto-install
# `gh` ONLY when a token is present — no point paying the cost otherwise.
#
# Install source is the official github.com release tarball, NOT apt: the default
# Ubuntu build is gh 2.45.0, which lacks `gh api --slurp` that pr:ready-state
# relies on, and the cli.github.com apt repo is not allowlisted. github.com
# releases ARE reachable. We deliberately do NOT run `gh auth setup-git`: the
# credential proxy already owns git auth and overriding it would break pushes.
# `gh` is used purely for the API (pr:ready-state / ship / babysit).
#
# Remote caveat: the git origin is the proxy URL, which gh does not recognise as
# a GitHub host, so gh cannot infer the repo. Pass `--repo <owner/name>` (the
# probe accepts it) or set a GH_REPO env var in the environment settings.
GH_API_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -n "$GH_API_TOKEN" ]]; then
  # Reinstall unless a gh that already supports `--slurp` is on PATH.
  if ! { command -v gh >/dev/null 2>&1 && gh api --help 2>/dev/null | grep -q -- '--slurp'; }; then
    echo "==> GH_TOKEN detected; installing current gh from the GitHub release tarball"
    gh_tmp="$(mktemp -d)"
    gh_arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
    # `|| gh_tag=""` keeps a blocked/timed-out lookup from tripping `set -e` and
    # aborting the whole bootstrap — the optional gh install must degrade to the
    # MCP fallback, never fail setup. The pipe runs under pipefail, so the bare
    # assignment's non-zero status would otherwise terminate the script here.
    gh_tag="$(curl -fsS -o /dev/null -w '%{redirect_url}' --max-time 20 \
      https://github.com/cli/cli/releases/latest | sed -E 's@.*/tag/@@')" || gh_tag=""
    if [[ -n "$gh_tag" ]] &&
      curl -fsSL --max-time 90 -o "$gh_tmp/gh.tgz" \
        "https://github.com/cli/cli/releases/download/${gh_tag}/gh_${gh_tag#v}_linux_${gh_arch}.tar.gz" &&
      tar -xzf "$gh_tmp/gh.tgz" -C "$gh_tmp"; then
      sudo install -m755 "$gh_tmp/gh_${gh_tag#v}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh ||
        echo "WARN: gh install step failed; falling back to the GitHub MCP server." >&2
    else
      echo "WARN: gh download failed (github.com release blocked?); falling back to the GitHub MCP server." >&2
    fi
    rm -rf "$gh_tmp"
    hash -r 2>/dev/null || true
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "WARN: gh is not installed (download failed above); using the GitHub MCP server for PR/API work." >&2
  elif ! gh api --help 2>/dev/null | grep -q -- '--slurp'; then
    # An older gh may still be on PATH if the tarball upgrade failed (no sudo,
    # blocked download). pr:ready-state calls `gh api --paginate --slurp`, which
    # that binary lacks, so do NOT advertise availability — force the MCP fallback.
    echo "WARN: gh on PATH is too old (no 'gh api --slurp'); the release-tarball upgrade did not apply." >&2
    echo "WARN: pr:ready-state needs --slurp; using the GitHub MCP server for PR/API work meanwhile." >&2
  elif gh auth status >/dev/null 2>&1; then
    echo "gh is installed and authenticated via GH_TOKEN; gh-backed PR flows (pr:ready-state) are available."
    echo "Reminder: pass --repo <owner/name> (or set GH_REPO) — the git remote is the local proxy, not a GitHub host."
  else
    echo "WARN: gh is installed but not authenticated — check the GH_TOKEN scopes/org approval." >&2
    echo "WARN: using the GitHub MCP server for PR/API work meanwhile." >&2
  fi
else
  echo "No GH_TOKEN set: using the GitHub MCP server for PR/API work (default)."
  echo "To enable gh-backed flows (pr:ready-state/ship/babysit), set a fine-grained GH_TOKEN"
  echo "(and optionally GH_REPO=<owner/name>) in the environment settings; gh then auto-installs here."
fi

echo "Claude Code on the web setup complete."
