---
title: An untrusted agent's MCP credentials sit behind a loopback broker, not in its env
status: active
owner: eng
canonical: true
last_verified: 2026-07-30
scope: ci/process
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0056 — An untrusted agent's MCP credentials sit behind a loopback broker, not in its env

**Status:** Accepted (Jul 2026), in force.
**Scope:** ci/process (the Sentry triage agent first; the pattern for any future
MCP credential handed to an untrusted agent).

## Context

[ADR 0036](0036-sentry-triage-pipeline.md) runs Stage B triage as a
`claude-code-action` agent that reads Sentry over an MCP server. The Claude CLI
launches that server as a child of the agent's own process, and
`claude-code-action` is a composite action: GitHub Actions does not pass a
caller step's `env:` into a composite action's steps, and the pinned v1.0.179
exposes no per-step passthrough and no first-class MCP env input. So anything
the MCP server must read had to be **job** env — which the agent's allow-listed
Bash inherits.

That is not containable downstream. The agent authors its own shell command, so
bash expands and transforms `$VAR` before any wrapper receives argv:
`--body "…${TOKEN:0:4}x${TOKEN:4}"` posts the whole token with one removable
character spliced in, reproduced against the real CLI
([#1711](https://github.com/mento-protocol/monitoring-monorepo/issues/1711)).
The verbatim-value scan in `scripts/sentry-triage-agent-comment.mjs` catches the
accident and was never a leak control. Exact-value scanning is structurally the
wrong layer when the adversary controls the shell.

## Decision

**Keep the credential out of the untrusted agent's process env. A trusted step
holds it and hands the agent a per-run handle that is worthless off-runner.**

- A trusted step, ordered before the agent and holding the secret **step-scoped**,
  starts `scripts/sentry-mcp-broker.mjs` bound to `127.0.0.1` and mints an
  opaque handle (`openssl rand -hex 32`).
- The MCP server runs with `--host 127.0.0.1:<port> --insecure-http` and the
  handle as its access token. The broker validates the handle, substitutes the
  real credential and forwards over HTTPS.
- The broker is **read-only and allow-listed**: non-GET is refused outright, and
  the path allowlist is the empirically derived closure of the granted tools —
  produced by driving them against a capture server, never guessed from tool
  names. Upstream redirects are refused rather than relayed, because the MCP
  client would follow one with the handle.
- The handle travels through `$GITHUB_ENV`; the credential never does.
  `$GITHUB_ENV` exposes a value to every later step, which is correct for an
  authenticator scoped to a loopback process on this runner and wrong for a
  credential.
- **The handle's worthlessness is the load-bearing property**, not an
  afterthought: loopback-only binding is a constant with no override, the handle
  is minted per run, and the broker dies with the runner.

## Alternatives considered

- **Wait for per-step or first-class MCP env forwarding in
  `claude-code-action`.** Cheapest fix if it lands. Absent at the pinned
  v1.0.179 and upstream's only release tag is `v1` (Aug 2025), so there is no
  newer version to adopt. Re-check on the next bump; the broker generalises to
  the next MCP credential either way.
- **Write the resolved `--mcp-config` to `$RUNNER_TEMP`.** Rejected: it
  relocates the credential to a file the agent's `Read` tool can open.
- **Scrub or transform the credential in the agent's env.** Rejected: the
  credential must be readable by a child of the agent's own process, so any
  value the MCP server can read, the agent can read.
- **Harden the comment wrapper further.** Rejected on the finding above — no
  check inside a wrapper closes a channel the shell opens before argv exists.

## Consequences

- Bumping the MCP server means **re-deriving the path allowlist** by the same
  empirical method. A path the broker refuses fails the leg loudly with the path
  named in its log, so a stale allowlist is visible, not silent.
- The broker rewrites `links.regionUrl` on organization payloads to its own
  origin. This is a correctness requirement, not hardening: the upstream value
  steers both the MCP server's internal reads and the agent's later calls off
  the broker. `links.organizationUrl` stays untouched so permalinks stay real.
- **Accepted residual — regionUrl steering.** Three granted tools take an
  agent-controlled `regionUrl`, and the MCP server's `validateRegionUrl` accepts
  a hardcoded SaaS set, keeps only the host and re-applies its own protocol
  (`http` under `--insecure-http`). An injected agent can therefore send its
  `Authorization` header to `http://us.sentry.io/...` in cleartext, past the
  broker. Sentry egress is not closed on the runner and this decision does not
  assume it is. What leaks is the handle, which is worth nothing outside the
  run. Tracked in
  [#1718](https://github.com/mento-protocol/monitoring-monorepo/issues/1718).
- **Accepted residual — `CLAUDE_CODE_OAUTH_TOKEN`.** `claude-code-action` places
  it in the agent's process env itself and this decision does not remove it. It
  is inference-only: worst case is inference-quota abuse, not repo or queue
  compromise, and any use lands in an auditable public comment.
- **No stop step.** The agent job must end with the agent (a later step's bash
  would source a `$GITHUB_ENV`-injected `BASH_ENV` payload), so the broker
  bounds its own life with a TTL on an ephemeral runner instead.

## Evidence

- [#1711](https://github.com/mento-protocol/monitoring-monorepo/issues/1711) —
  the reproduced splice past the wrapper's verbatim scan.
- Probes against the real `@sentry/mcp-server@0.37.0`: `--host` + `--insecure-http`
  works over loopback; `--insecure-http` is CLI-only; a loopback host disables the
  `~/.sentry/mcp.json` cache and the device-code OAuth fallback, so a missing
  token exits 1 rather than falling back; `validateRegionUrl` accepts
  `{sentry.io, us.sentry.io, de.sentry.io}` and the steering bypass reproduces.
- Enforced by `scripts/sentry-mcp-broker.mjs`,
  `scripts/sentry-mcp-broker.test.mjs` (fail-closed and mutation-checked), and
  `.github/workflows/sentry-triage-agent.yml`. Operator detail in
  [`docs/notes/sentry-triage-pipeline.md`](../notes/sentry-triage-pipeline.md).
