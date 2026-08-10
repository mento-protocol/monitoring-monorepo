---
title: Upstash MCP operator setup
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Upstash MCP operator setup

Use this path only for an attended local forensic-report upload. Codex Cloud can
load the repository because `.codex/config.toml` intentionally has no Upstash
entry; Cloud secrets disappear before the agent phase and cannot safely start
this server. In Cloud, finish the draft and hand the upload to a local session
or the authenticated dashboard editor.

## Reviewed transport

The workspace pins `@upstash/mcp-server@0.2.4` in `package.json` and
`pnpm-lock.yaml`. Normal repository setup installs that reviewed artifact. The
personal config launches the reviewed entrypoint directly with
`node node_modules/@upstash/mcp-server/dist/index.js --disable-telemetry`. It
cannot install a missing package or resolve a newer version from the registry
at startup.

- npm integrity:
  `sha512-LN5yao74QQZTjGmolGqAh9YkQa/206ni94wwTtu6I/mVkyMeAbRME7rjK64KrWmCTw2OHUb8TMFsw6r4rMmUSQ==`
- npm shasum: `4b2a627dbce2773f000a0e14d15e61a7ca1150f8`
- upstream git commit: `e3ab3c20ebd7d0e195cd774004fdb4c3dcb448d1`

The published entrypoint reads `UPSTASH_EMAIL` and `UPSTASH_API_KEY` when the
matching command flags are absent. The reviewed config omits those flags,
disables upstream telemetry, and exposes only
`redis_database_list_databases` and
`redis_database_run_redis_commands`. Updating the version requires reviewing
the new published artifact, recording its integrity and commit here, and
updating the focused contract test.

## Provision or rotate the key

[ADR 0060](../adr/0060-upstash-management-key-bootstrap.md) owns this bootstrap
exception. An authorized human must approve and perform each key creation and
revocation in [Upstash Console](https://console.upstash.com/account/api). Agents
must not click, call, or script those mutations.

For first setup:

1. Get explicit human approval to create a dedicated management key.
2. The human creates a key named `monitoring-forensic-upload-<owner>` in Upstash
   Console and stores the email and key in the approved external secret manager.
3. Keep the values out of shell history, repo files, Codex config, command
   arguments, support output, and chat. Do not use `codex mcp add` with
   credential flags.

For rotation:

1. Get explicit human approval, then have the human create a replacement key.
2. Update the external secret-manager record.
3. Start a fresh attended Codex session and verify database discovery.
4. After verification, get explicit approval and have the human revoke the old
   key. Retain the old key until step 3 succeeds.

The key is account-wide. A read-only key cannot run the Redis write used by the
CAS uploader, so tool allowlisting and the MCP approval prompt are required
controls rather than substitutes for provider-side least privilege.

## Configure local Codex

Copy the `mcp_servers.upstash` tables from
[`.codex/upstash-mcp.example.toml`](../../.codex/upstash-mcp.example.toml) into
`~/.codex/config.toml`. Keep `enabled = false` as the normal state. Do not add an
Upstash table to the repository's `.codex/config.toml`. Start Codex from this
repository so the launcher resolves the workspace-installed binary.

For an attended upload session, use the approved secret-manager integration to
inject `UPSTASH_EMAIL` and `UPSTASH_API_KEY` into the Codex process and enable
the server with the highest-precedence one-session override:

```bash
codex --config 'mcp_servers.upstash.enabled=true'
```

The command contains no credential. Do not replace it with literal `export`
examples or credential-bearing flags; both are easy to capture in history or
diagnostic output. Desktop and IDE sessions must receive the same two process
environment values from the external secret manager before startup, then use a
personal `enabled = true` only for the attended session.

## Validate without exposing values

Run the repository contract test first:

```bash
node --test scripts/upstash-mcp-config.test.mjs
```

The example stores only environment-variable names, so `codex mcp list` cannot
render the credential values for this server. Still treat the full command as
secret-adjacent because another personal server may use unsafe arguments. For a
shared log, record only these facts after redaction:

- server name is `upstash`;
- workspace package and lockfile resolve exactly `@upstash/mcp-server@0.2.4`;
- credential flags are absent;
- forwarded names are `UPSTASH_EMAIL` and `UPSTASH_API_KEY`;
- only the two reviewed tools are enabled;
- Redis command execution requires a prompt.

Never print the process environment to validate this setup. In the attended
session, call database discovery and confirm the exact `address-labels` result;
do not perform a write as a connectivity test.
