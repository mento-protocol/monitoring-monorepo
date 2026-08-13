---
title: Peg history reads Grafana Cloud through a dedicated read-only token
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
scope: ui-dashboard / terraform/infra
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0063 — Peg history reads Grafana Cloud through a dedicated read-only token

**Status:** Accepted (Aug 2026). Amends
[ADR 0049](0049-peg-decision-package-read-model.md), which stays in force for
current-state evidence. The Terraform is checked in and unapplied; a
human-approved platform apply activates the identity and the dashboard
environment. **Scope:** ui-dashboard / terraform/infra

## Context

ADR 0049 gave the peg board one bounded current-state input, `GET
/peg/decision-packages`, and rejected two roads to get there: parsing Prometheus
in the dashboard, and querying Grafana or providers from the dashboard. Both
rejections answered the same question — where does _current_ peg evidence come
from — and both turned on the same argument: a second observation path would
carry different timing and failure semantics than the one the decision package
commits.

The 2a board ([#1830](https://github.com/mento-protocol/monitoring-monorepo/issues/1830))
asks a different question. Its Peg History chart needs a 24h/7d/30d deviation
series per asset, and the follow-up alerts feed
([#1832](https://github.com/mento-protocol/monitoring-monorepo/issues/1832))
needs firing and pending transitions over the same windows. Metrics Bridge holds
neither: ADR 0049 kept the read model bounded and in memory, and rejected a
history-retention contract in the bridge. The data exists in exactly one place.
Alloy scrapes `mento_peg_deviation_bps` and `mento_peg_policy_version` into
Grafana Cloud Mimir, and alert transitions land in the Loki-backed state history
behind `GET /api/v1/rules/history`. ADR 0049 already names Grafana authoritative
for duration, coverage, pending/firing state, and notifications — the history
question was answered there, just never wired up.

Reaching that store needs a credential. The organization has one Grafana token
today, the Admin service-account token that `alerts/rules` and `aegis` use to
provision folders, rules, and routing. Handing it to a browser-facing service
would give the dashboard authority to rewrite the alert plane.

## Decision

Current-state peg evidence keeps exactly one source. The decision package
remains the only input to the current-state board, and nothing on the history
path may feed it.

Historical series and alert state history are read from Grafana Cloud,
server-side, through a dedicated identity:

- A new `grafana_service_account` with the **Viewer** basic role. Viewer is the
  least role that grants both capabilities the board needs — querying a
  datasource for the Mimir range queries, and reading alert rules and instances
  for the state history API. Editor is the next role up and adds write access to
  dashboards, folders, and alert rules. Grafana attaches no scope to a token, so
  the role is the entire boundary; widening it widens every request the
  dashboard can make.
- A `grafana_service_account_token` on that account, never the `alerts/rules`
  Admin token. The two identities have separate lifecycles: disabling the
  service account revokes history and leaves alert provisioning untouched.
- Two server-only Vercel environment variables, `GRAFANA_QUERY_URL` and
  `GRAFANA_QUERY_TOKEN`. Neither carries a `NEXT_PUBLIC_` prefix; the browser
  calls same-origin dashboard routes and the token stays out of client bundles.

The `platform` stack owns all of it. `terraform.stacks.json` gives that stack
the dashboard Vercel project and its environment, this identity exists only to
serve that project, and minting it there lets the token travel from the resource
that creates it to the variable that consumes it inside one apply — the shape
`upstash_redis_database.address_labels.rest_token` already uses. The stack gains
the Grafana provider and an Admin provisioning input for that purpose alone; it
owns no Grafana rules, folders, or dashboards.

Rotation is a reviewed counter, `grafana_dashboard_reader_token_rotation_counter`.
`scripts/tf-platform-plan-guard.mjs` parses platform Terraform arguments against
a strict allowlist, so `-replace` is unavailable on this stack, and
[ADR 0030](0030-iac-before-cli-secrets.md) rules out rolling the credential by
hand in the Grafana console. Incrementing the counter mints the replacement and
pushes it to Vercel in the same apply.

History is an isolated failure domain. A Grafana outage, a revoked token, or a
5xx from a history route must leave the current-state board rendering from the
decision package. History routes degrade to an unavailable series and never
block, delay, or fail the current-state fetch.

## Alternatives considered

- **Persist history in Metrics Bridge** — rejected again, for ADR 0049's
  original reason. It buys a second datastore and a retention contract for data
  the metrics store already keeps, and the bridge would still not hold alert
  state transitions.
- **Reuse the `alerts/rules` Admin token** — rejected. It provisions the whole
  Grafana organization. A dashboard that can rewrite alert rules is a much worse
  trade than a second credential.
- **Mint the token in `alerts-rules` or `aegis` and hand it to `platform`** —
  rejected. Neither stack owns the dashboard, and no stack in this repo reads
  another's state (`terraform_remote_state` appears nowhere). The handoff would
  need a Secret Manager round trip, a provider each stack does not have today,
  and two ordered applies to rotate one credential.
- **Query Grafana Cloud Mimir directly with a Cloud access policy token** —
  rejected. It opens a second credential class and the Cloud API surface, while
  the stack service-account token already reaches both the metrics datasource
  and alert state history.
- **Fetch history from the browser** — rejected. The token would have to ship to
  the client, and the board would gain a cross-origin failure mode it cannot
  contain.

## Consequences

- ADR 0049's boundary is now explicit: the decision package answers _what is
  true now_, Grafana answers _what happened_. The amendment is recorded in ADR
  0049 itself.
- The dashboard holds a Grafana credential. Access review must count it. Its
  blast radius is read access to Mento's own monitoring telemetry, and it is
  revocable without touching the alert plane.
- The `platform` stack now needs `grafana_provisioning_token` in the operator's
  gitignored tfvars. A platform apply fails without it, the same way it fails
  without `vercel_token`.
- Both environment variables target production and preview, matching
  `METRICS_BRIDGE_URL` and `UPSTASH_REDIS_REST_TOKEN`. Preview is where
  dashboard UI changes get verified, and Vercel SSO plus Git fork protection are
  the controls that already justify shared preview credentials
  ([ADR 0022](0022-authjs-google-shared-preview-secrets.md)).
- Read routes address the Mimir datasource by its stable UID
  `grafanacloud-prom` rather than discovering it, so the read path does not
  depend on datasource-listing permission. That UID is reviewed non-secret
  dashboard source, not another environment variable.
- The history route, the chart wiring, and the alerts feed stay separate work
  ([#1831](https://github.com/mento-protocol/monitoring-monorepo/issues/1831)
  steps 3–4 and
  [#1832](https://github.com/mento-protocol/monitoring-monorepo/issues/1832)).
  Checked-in Terraform alone activates nothing.

## Evidence

- `terraform/grafana-read-access.tf` — service account, rotation trigger, token
- `terraform/dashboard.tf` — `GRAFANA_QUERY_URL`, `GRAFANA_QUERY_TOKEN`
- `terraform/providers.tf`, `terraform/variables.tf`,
  `terraform/terraform.tfvars.example`
- `terraform.stacks.json` — `platform` records the `grafana` provider
- [ADR 0049](0049-peg-decision-package-read-model.md) §"Amendment — ADR 0063"
- [ADR 0030](0030-iac-before-cli-secrets.md),
  [ADR 0061](0061-exact-plan-guard-for-manual-platform-applies.md)
- 2026-08-13 live check against `https://clabsmento.grafana.net`:
  `GET /api/v1/rules/history` returns the Loki-backed `states` frame, and the
  Mimir datasource is `grafanacloud-prom`
  (`grafanacloud-clabsmento-prom`).
