# Security guidance — Mento monitoring-monorepo

Project-specific rules for the model-backed security reviewer. Additive to the
built-in vulnerability checklist. These are guidance; PR review and `/red-team`
remain the enforcement layers.

## Secrets and credentials

- Never log, echo, or persist values from `AUTH_SECRET`, `KV_REST_API_TOKEN`,
  `KV_REST_API_READ_ONLY_TOKEN`, `ENVIO_HASURA_TOKEN`, `SENTRY_AUTH_TOKEN`,
  `*_SLACK_BOT_TOKEN`, `DUNE_API_KEY`, `ARKHAM_API_KEY`, or any value sourced
  from `.env*`. Redact before passing into logs, error messages, or Sentry
  breadcrumbs.
- Never commit `.env`, `.env.local`, `.env.production.local`, or any file
  matching `*credential*`, `*secret*`. Example files (`.env.example`,
  `.env.production.local.example`) with placeholder values are allowed.
- Hardcoded private keys (`0x[a-f0-9]{64}` outside test fixtures) and bearer
  tokens (`sk_live_`, `AKIA`, `xoxb-`, `xoxe.xoxp-`, `xoxa-2-`) must come from
  env vars resolved at runtime, never literals.

## GCP and Terraform

- App code (indexer-envio, ui-dashboard, aegis, metrics-bridge) must never
  shell out to `gcloud`. Sandbox-side reads use the `mcp__gcloud__*` MCP
  tools with agent-readonly SA impersonation. Server-side reads use the
  GCP client libraries with workload identity, not the CLI.
- Terraform secret values (`*.tfvars`, `*.auto.tfvars`) stay in the main
  checkout only — never copy them into worktrees, never commit them, never
  echo them. The GCS backend in `terraform/` is the source of truth.

## Indexer (indexer-envio)

- BigInt arithmetic: amounts, balances, supply, trading-limit counters, and
  block timestamps must use `bigint`. Never coerce via `Number(x)` —
  precision loss above 2^53 is silent. Schema fields marked
  `@config(precision: 78)` are `bigint[]` in TS / `numeric[]` in Postgres.
- Trading-limit state (Mento v2) is keyed on `bytes32(exchangeId XOR token)`,
  NOT on trader. Logic that "resets" limits by rotating callers is wrong;
  surface this as a finding.
- RPC handling: handlers must not assume getter calls succeed. Use the
  `rpc/` helpers (`tryRead`, heal effects), and report missing data via
  `context.log.error("<area>.<event>", { ... })`. Never `throw` from a
  handler — it halts the indexer; this is a Sev-1 condition.
- Bridge/NTT transceiver and FPMM addresses must be read from
  `indexer-envio/config/nttAddresses.json` and the chain registry, not
  hardcoded inline. Mismatched addresses across chains have caused outages.

## Dashboard (ui-dashboard)

- Hasura/Envio queries: NEVER ship `_aggregate` queries. They are unbounded
  on prod and have caused 429 storms. Use pre-rolled snapshot entities or
  paginate + count client-side.
- No `dangerouslySetInnerHTML` or `.innerHTML =` on values that include any
  on-chain string (token names, address-book report bodies, Arkham labels).
  Treat these as untrusted — they can carry HTML injected by an attacker
  who controls a contract or address-book entry.
- SWR keys: do not embed raw URL components from user input or from arbitrary
  Hasura response strings into URL paths without `encodeURIComponent`.
- Server actions and route handlers (`app/api/**`, `actions/**`) that mutate
  state must check `auth()` before any side effect. The Vercel project is
  protected by Auth.js — that protection does NOT extend to route handlers
  that bypass middleware.

## Aegis / metrics-bridge (Prometheus exporters)

- Both services are outbound pollers, not webhook receivers — aegis polls
  on-chain view calls, metrics-bridge polls Hasura + RPC probes. The only
  inbound routes are `GET /metrics` and `GET /health`; no body parsing.
- Prometheus labels must have bounded cardinality. Never expose tx hashes,
  user addresses, or pool-specific free text as unbounded labels — they
  blow up Grafana storage and break dashboards.
- Loki + Grafana: error events emitted as `context.log.error("<area>.<event>")`
  in the indexer are deduped per process for alert routing. Don't emit
  identical signatures from unrelated code paths — it breaks the per-area
  dedup.

## Webhook receivers (alerts/infra/onchain-event-handler)

- The QuickNode webhook receiver (`alerts/infra/onchain-event-handler/`,
  GCP Cloud Function) MUST verify the QuickNode signature via
  `verify-quicknode-signature.ts` BEFORE parsing the request body. Reject
  unauthenticated requests early.
- Outbound destinations (Slack, Discord) are templated. Never pass a
  request-controlled string directly into the channel selector or the
  message body without escaping `<>&` in mrkdwn/HTML targets.

## GitHub Actions / supply chain

- Any change under `.github/workflows/*` is high-blast-radius. Workflows
  must SHA-pin third-party actions (not `@v1` / `@main` tags). `pull_request`
  triggers must NOT grant `pull-requests: write` or `contents: write`
  unless they also gate on `github.event.pull_request.head.repo.full_name`
  matching the upstream repo (forks shouldn't get write tokens).
- Required-status CI checks must NOT use `paths:` filters — that creates
  permanently-pending checks on PRs that don't touch the paths and blocks
  the merge queue.
