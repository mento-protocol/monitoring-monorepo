---
title: Upstash management API keys use a human-owned bootstrap integration
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: terraform/infra
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0060 — Upstash management API keys use a human-owned bootstrap integration

**Status:** Accepted (Aug 2026), in force.
**Scope:** terraform/infra and attended local operator access.

## Context

The platform Terraform provider and the optional forensic-report MCP uploader
both authenticate to the Upstash Developer API with an account email and a
management API key. Upstash creates and deletes these keys only through its
account console. Terraform cannot create the credential that its own Upstash
provider needs before planning.

The provider bootstrap key and the forensic uploader also have different
lifecycles. Reusing one key would couple an attended report upload to every
Terraform operation. Upstash supports separately named keys and recommends a
different key for each application, but its management keys do not offer the
database-scoped write permission the uploader needs. The uploader key therefore
has account-wide impact even though Codex exposes only two MCP tools.

## Decision

Treat Upstash management-key lifecycle as a documented owning integration under
[ADR 0030](0030-iac-before-cli-secrets.md):

- An authorized human creates, replaces, and revokes keys in Upstash Console
  only after explicit approval. Agents never perform those mutations through a
  browser, CLI, MCP tool, or API.
- Use separate named keys for Terraform and the attended forensic uploader. The
  uploader key name starts with `monitoring-forensic-upload-` and includes its
  human owner. Keep the source of truth in the approved external secret
  manager.
- Terraform continues to consume its key through the sensitive
  `upstash_email` and `upstash_api_key` inputs. The checked-in source declares
  the input contract. Materialize the Terraform key only in the gitignored
  operator input that the current wrapper expects; plaintext stays out of
  tracked repository files.
- Local Codex receives the uploader key only as `UPSTASH_EMAIL` and
  `UPSTASH_API_KEY` process environment values injected by the external secret
  manager for an attended session. The personal MCP config forwards the names,
  never the values. Shared project config and Codex Cloud receive neither the
  transport nor the credential.
- Rotation is create replacement, update the owning secret-manager record,
  start a fresh attended session and verify database discovery, then revoke the
  predecessor. Each create and revoke is a separate human-approved console
  action so rollback remains possible until verification passes.

The operator procedure and pinned MCP artifact live in
[`docs/notes/upstash-mcp-operator.md`](../notes/upstash-mcp-operator.md).

## Alternatives considered

- **Let Terraform create its provider credential.** Impossible: provider
  authentication is required before Terraform can manage any Upstash resource,
  and Upstash does not expose management-key lifecycle through that provider.
- **Reuse the Terraform key for forensic uploads.** Rejected: it couples
  rotation and expands the number of sessions that handle the infrastructure
  bootstrap credential.
- **Put the key in MCP arguments or checked-in environment values.** Rejected:
  Codex diagnostics render configured arguments, and repository or Cloud config
  would expose a production credential.
- **Install the personal MCP transport through shared project config.**
  Rejected: Codex Cloud does not inherit local credentials, and Cloud secrets
  are removed before the agent phase. A shared enabled server would fail or
  invite secret material into the repository.

## Consequences

- The human-owned console path is a narrow bootstrap exception, not permission
  for other manual secret changes. Every downstream Upstash resource and
  runtime Redis credential remains Terraform-owned.
- The forensic uploader key has account-wide power because Upstash has no
  database-scoped management key for this write path. Keep MCP approval prompts
  enabled and expose only database discovery plus Redis command execution.
- Codex Cloud can investigate and draft reports but cannot use the MCP upload
  path. Upload from an attended local session or use the authenticated dashboard
  editor.
- Key values remain reachable to the attended local Codex process. This path
  protects configuration and logs; it is not the isolated broker boundary from
  [ADR 0056](0056-agent-mcp-credential-broker.md). Do not use it for unattended
  or untrusted-agent execution.

## Evidence

- [Issue #1770](https://github.com/mento-protocol/monitoring-monorepo/issues/1770)
  records the transport, redaction, ownership, and Cloud acceptance criteria.
- Upstash documents console-only creation, multiple named keys, and separate
  keys per application in its Developer API introduction.
- OpenAI documents that Codex Cloud secrets exist only during setup and are
  removed before the agent phase.
- Enforced by `.codex/upstash-mcp.example.toml` and
  `scripts/mcp/upstash-mcp-config.test.mjs`.
