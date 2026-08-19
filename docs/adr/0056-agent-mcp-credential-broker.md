---
title: An untrusted agent's MCP credentials sit behind a loopback broker, not in its env
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
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
caller step's `env:` into a composite action's steps, and the pinned v1.0.183
exposes no per-step passthrough and no first-class MCP env input. So anything
the MCP server must read had to be **job** env — which the agent's allow-listed
Bash inherits.

That is not containable downstream. The agent authors its own shell command, so
bash expands and transforms `$VAR` before any wrapper receives argv:
`--body "…${TOKEN:0:4}x${TOKEN:4}"` posts the whole token with one removable
character spliced in, reproduced against the real CLI
([#1711](https://github.com/mento-protocol/monitoring-monorepo/issues/1711)).
The verbatim-value scan in `scripts/sentry/triage/sentry-triage-agent-comment.mjs` catches the
accident and was never a leak control. Exact-value scanning is structurally the
wrong layer when the adversary controls the shell.

## Decision

**Keep the credential out of the untrusted agent's REACH — not merely out of its
own environment. A trusted step holds it and hands the agent a per-run handle
that is worthless off-runner.**

Out of the agent's own env is not the property that matters, and stopping there
is the mistake this ADR exists to name. Every step runs as `runner` and the
agent holds `Read`, so **every same-UID-readable surface is agent-reachable**:
`/proc/<pid>/environ` and `/proc/<pid>/cmdline` of every process in the job, and
every file on disk. A broker that merely inherited the token from its step's
`env:` would have left it one `Read` away, and the step logs the broker's PID.

**`/proc/<pid>/environ` is the environment captured at `exec`.** Deleting the
variable inside the process afterwards does not change it, so any scrub after
start is theatre. The variable must be absent when the process is exec'd. So:

- The trusted step copies the secret to a shell-local, `unset`s the exported
  name, and only then spawns node — and hands the token over on **stdin**,
  written by `printf`, a bash **builtin**. That covers all three surfaces: no
  env var, no argv (a builtin in a pipeline runs in a forked subshell that never
  execs, so its `cmdline` stays the parent shell's), and no temp file (a
  pipeline uses an anonymous pipe, unlike `<<<` or `<<`).
- The broker **refuses to start** if it finds the token in its own exec-time
  environment, checked against a snapshot taken at module load. A regression in
  the workflow becomes a loud startup failure rather than a silent leak.
- The secret reaches the step through an `env:` binding and never through
  `${{ secrets.* }}` inside the `run:` body. That is deliberate, not style:
  GitHub expands `${{ }}` **before** writing the step script to `$RUNNER_TEMP`,
  so an inline secret would sit in plaintext on disk for the life of the job —
  the same same-UID-readable class. Through `env:` the script holds only the
  variable name.
- The trusted step's own shell still holds the token in its environment. That is
  acceptable only because each `run:` step is its own process and the runner
  gates the next step on this one's exit code, so it is gone before the agent
  starts. The broker deliberately outlives its step, which is exactly why its
  environment is the one that had to be cleaned.

- A trusted step, ordered before the agent and holding the secret **step-scoped**,
  starts `scripts/sentry/broker/sentry-mcp-broker.mjs` bound to `127.0.0.1` and mints an
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
  `claude-code-action`.** Cheapest fix if it lands. Still absent at the pinned
  v1.0.183, whose `action.yml` is byte-identical to the v1.0.179 this ADR was
  written against; upstream deprecated the old `mcp_config` input in favour of
  `claude_args: --mcp-config`, which takes a path or JSON and never env.
  Re-check on the next bump; the broker generalises to the next MCP credential
  either way.
- **Write the resolved `--mcp-config` to `$RUNNER_TEMP`.** Rejected: it
  relocates the credential to a file the agent's `Read` tool can open.
- **Scrub or transform the credential in the agent's env.** Rejected: the
  credential must be readable by a child of the agent's own process, so any
  value the MCP server can read, the agent can read.
- **Let the broker inherit the token and `delete process.env.<name>` at
  startup.** Rejected, and recorded because it is the plausible wrong fix:
  `/proc/<pid>/environ` is fixed at `exec`, so the file still shows the original
  block. A mutation test pins this — scrubbing at runtime must fail the suite.
- **A temp file the broker reads and unlinks.** Rejected: readable by the agent
  for the window it exists, and a broker that dies mid-read leaves it behind.
  Stdin has no such window and no such remnant.
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
- **Accepted residual — heap residency, UNVERIFIED.** The token now lives in the
  broker's heap. Reading `/proc/<pid>/mem` requires `PTRACE_MODE_ATTACH`, which
  Yama's `ptrace_scope=1` denies to a non-descendant same-user process — but the
  GitHub runner's setting is not established, and this ADR does not claim it.
  The broker step logs `/proc/sys/kernel/yama/ptrace_scope` so the first real
  run settles it. If it reports `0`, heap residency is genuinely reachable and
  needs its own mitigation.
- **Reachability inventory (checked, negative).** Audited for what an agent with
  `Read` on this runner can actually reach, rather than assumed:
  **zero** steps across all 31 workflows interpolate `${{ secrets.* }}` into a
  `run:` body (the only three inline expressions anywhere are `github.base_ref`,
  `matrix.id` and `github.sha`); the triage job's single `$GITHUB_ENV` write is
  the broker handle and its single `$GITHUB_OUTPUT` write is the rendered
  prompt; the staged `sentry-triage-tools` directory is agent-readable by design
  and holds only files already public in this repo; `target.json` holds a repo
  name and a public issue number; and the broker's log is method, path, status
  and refusal reason only. Nothing sensitive in any of them.

## Evidence

- [#1711](https://github.com/mento-protocol/monitoring-monorepo/issues/1711) —
  the reproduced splice past the wrapper's verbatim scan.
- Probes against the real `@sentry/mcp-server@0.37.0`: `--host` + `--insecure-http`
  works over loopback; `--insecure-http` is CLI-only; a loopback host disables the
  `~/.sentry/mcp.json` cache and the device-code OAuth fallback, so a missing
  token exits 1 rather than falling back; `validateRegionUrl` accepts
  `{sentry.io, us.sentry.io, de.sentry.io}` and the steering bypass reproduces.
- Enforced by `scripts/sentry/broker/sentry-mcp-broker.mjs`,
  `scripts/sentry/broker/sentry-mcp-broker.test.mjs` (fail-closed and mutation-checked), and
  `.github/workflows/sentry-triage-agent.yml`. Operator detail in
  [`docs/notes/sentry-triage-pipeline.md`](../notes/sentry-triage-pipeline.md).
