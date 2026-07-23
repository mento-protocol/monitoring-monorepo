# Security guidance — Mento monitoring-monorepo

Project-specific semantic rules for the official
`security-guidance@claude-plugins-official` model-backed diff reviewer. The
plugin must be installed/enabled by the developer; this repo does not declare a
user-scoped plugin installation. Regex-enforceable patterns live in
`.claude/security-patterns.json`; canonical workflow detail lives in package
instructions and PR checklists. These rules supplement, but do not replace,
`/security-review`, autoreview, tests, or normal PR gates.

## Secrets and credentials

- Never log, echo, or persist secrets such as `AUTH_SECRET`,
  `UPSTASH_REDIS_REST_TOKEN`, `ENVIO_API_TOKEN`, `SENTRY_AUTH_TOKEN`,
  QuickNode credentials, Slack bot tokens, or third-party API keys. Redact them
  before logs, errors, or Sentry breadcrumbs.
- Never commit `.env`, `.env.local`, `.env.production.local`, or any file
  matching `*credential*`, `*secret*`. Example files (`.env.example`,
  `.env.production.local.example`) with placeholder values are allowed.
- Hardcoded private keys (`0x[a-f0-9]{64}` outside test fixtures) and bearer
  tokens (`sk_live_`, `AKIA`, `xoxb-`, `xoxe.xoxp-`, `xoxa-2-`) must come from
  env vars resolved at runtime, never literals.

## GCP and Terraform

- App code must never shell out to `gcloud`. Agent-side inspection uses an
  available read-only connector; server-side reads use GCP client libraries
  with workload identity.
- Terraform secret values (`*.tfvars`, `*.auto.tfvars`) stay in the main
  checkout only — never copy them into worktrees, never commit them, never
  echo them. The backend registered for each Terraform stack is the state source
  of truth; do not infer ownership from directory names.

## Indexer (indexer-envio)

- BigInt arithmetic: amounts, balances, supply, trading-limit counters, and
  block timestamps must use `bigint`. Never coerce via `Number(x)` —
  precision loss above 2^53 is silent. Schema fields marked
  `@config(precision: 78)` are `bigint[]` in TS / `numeric[]` in Postgres.
- Trading-limit state (Mento v2) is keyed on `bytes32(exchangeId XOR token)`,
  NOT on trader. Logic that "resets" limits by rotating callers is wrong;
  surface this as a finding.
- RPC handling: handlers must not assume getter calls succeed. Use the effect
  helpers for transient getter/RPC failures and structured error reporting.
  Invariant violations, corrupt data, and failures before a safe write may
  intentionally throw and stop processing. Follow
  `docs/pr-checklists/indexer-handler-invariants.md`; do not apply a blanket
  throw/no-throw rule.
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
- Outbound Slack destinations are templated. Never pass a
  request-controlled string directly into the channel selector or the
  message body without escaping `<>&` in mrkdwn/HTML targets.

## GitHub Actions / supply chain

- Any change under `.github/workflows/*` is high-blast-radius. Workflows
  must SHA-pin third-party actions (not `@v1` / `@main` tags). `pull_request`
  triggers must NOT grant `pull-requests: write` or `contents: write`
  unless they also gate on `github.event.pull_request.head.repo.full_name`
  matching the upstream repo (forks shouldn't get write tokens).
- **Ruleset-required** CI checks must not use workflow-level `paths:` filters;
  skipped workflows leave required checks pending. Advisory workflows should
  use path filters. Read `docs/pr-checklists/ci-workflow-gates.md` and the live
  ruleset before changing either class.
