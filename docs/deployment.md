---
title: Deployment Guide
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Deployment Guide

## Architecture

This guide covers the two user-facing data surfaces that deploy independently:

- **Indexer** (`indexer-envio/`) → Envio Hosted Service
- **Dashboard** (`ui-dashboard/`) → Vercel (`monitoring-dashboard` project)

The repo also deploys Metrics Bridge, Aegis, alerting infrastructure,
integration probes, and Governance Watchdog. Use
[`terraform.stacks.json`](../terraform.stacks.json),
[`docs/terraform.md`](./terraform.md), and each package's `AGENTS.md` or README
for those owning workflows; do not infer their deployment policy from this
indexer/dashboard runbook.

---

## Indexer Deployment (Envio Hosted)

### Deploy Branch

The prod multichain indexer is driven by a single deploy branch that Envio watches:

| Networks               | Deploy Branch | Config File                      | Envio Project                  |
| ---------------------- | ------------- | -------------------------------- | ------------------------------ |
| Celo + Monad + Polygon | `envio`       | `config.multichain.mainnet.yaml` | `mento-protocol/mento` (Envio) |

### Endpoint URL

The indexer has a static production endpoint; the hash does not change on
redeployment:

```text
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

### Deployment Workflow

**Redeploy the prod indexer:**

```bash
# Push the guarded current HEAD to the envio branch (triggers Envio redeploy)
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
```

Then wait for the deployment to catch up and promote it:

```bash
pnpm deploy:indexer:status "$COMMIT" --watch --compact
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
pnpm deploy:indexer:perf "$COMMIT"
pnpm deploy:indexer:verify "$COMMIT"
pnpm deploy:indexer:promote "$COMMIT"
```

Promotion authority depends on the request. For a monitor-only or babysit
request, wait until every chain is caught up, run
`pnpm deploy:indexer:verify "$COMMIT"`, then stop until the user explicitly
approves the guarded `/deploy-indexer` continuation; do not offer the bare
promote wrapper as monitor closeout. For a pre-merge feature-branch preload,
`/deploy-indexer --no-promote` stops after sync. After merge,
`/deploy-indexer --resume-preload "$COMMIT"` first requires the preloaded
`indexer-envio/` tree to match freshly fetched protected `main` from the
canonical `mento-protocol/monitoring-monorepo` remote, then reconfirms sync and
runs the complete verify, prior-prod capture, promote, propagation-wait, and
UI-verification path. Do not infer promotion approval from a request to
monitor, preload, or report readiness; an explicitly authorized end-to-end
production deploy is a separate case.

### Force Retrigger Without Code Changes

If Envio gets stuck or you need to retrigger without a code change:

```bash
# A fresh SHA is required because pushing an unchanged ref emits no webhook.
git commit --allow-empty -m "chore: retrigger envio deploy"
pnpm deploy:indexer --yes
```

### After Redeployment Checklist

1. Wait for the deployed commit to register and catch up to the chain head (`pnpm deploy:indexer:status "$COMMIT" --watch --compact` for low-noise agent output, `pnpm deploy:indexer:status "$COMMIT" --watch` for the full terminal table, or [envio.dev/app](https://envio.dev/app)).
2. Inspect build and runtime errors with explicit commit-scoped logs (`pnpm deploy:indexer:logs "$COMMIT" --build` and `pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h`).
3. Capture a combined status/metrics/log snapshot for comparison (`pnpm deploy:indexer:perf "$COMMIT"`).
4. Verify sync, metrics, endpoint resolution, core rows, and fail-closed Polygon replay semantics (`pnpm deploy:indexer:verify "$COMMIT"`). The verifier reads `indexer-envio/config/replay-integrity.json` from that exact commit, so a pre-invariant replay cannot pass merely because later rows look healthy. A caught-up status alone is only `SYNCED_PENDING_DATA_VERIFY`.
5. Capture the current production commit for rollback, then promote the same caught-up, semantically verified commit (`pnpm deploy:indexer:promote "$COMMIT"`) and confirm its `prod_status=prod`. The `deploy-indexer` skill owns the exact prefix-safe query and guarded rollback command.
6. Wait the full five-minute static-endpoint propagation window.
7. Trigger a Vercel redeploy only if dashboard code or GraphQL fields changed and the dashboard has not already deployed from `main`.
8. Verify monitoring.mento.org in the browser, including the affected pages and console errors. A bare successful promote is not rollout closeout.

Reserve-yield actuals deploy through the primary `mento` Envio project. The
Ethereum sUSDS handlers in `config.multichain.mainnet.yaml` are event-only, and
stETH adds a launch-aligned sub-daily wallet balance sampler. The historical sUSDS
onBlock heartbeat is not part of the hosted path.

To check whether Envio's persistent effect cache is active for a deployment:

```bash
pnpm deploy:indexer:info <commit>
```

`cacheEnabled: true` here means that specific deployment restored from an Envio
cache. A project can still have indexer-level cache enabled while an older
deployment reports `cacheEnabled: false` because it was created before a cache
artifact was active. The current CLI settings command does not expose the
indexer-level cache toggle or cache-artifact selection; use the Envio dashboard
cache settings, or Envio support if the dashboard is unavailable.

### Rollback a Bad Promotion

If a promoted deployment turns out bad (schema-breaking change, handler crash
on a real block), roll the static production endpoint back to the last-good
commit:

1. Find the last-good SHA. List Envio's live deployments - the `prod` row is
   what is serving right now:

   ```bash
   pnpm --silent exec envio-cloud indexer get mento mento-protocol -o json \
     | jq -r '.data.deployments[] | [.commit_hash, (.prod_status // "-"), .created_time] | @tsv'
   ```

   The rollback script also fetches `origin/envio` and refuses slow rollbacks to
   commits outside that deploy-branch history.

2. Run the rollback. Preview the plan first with `--dry-run`:

   ```bash
   pnpm deploy:indexer:rollback <last-good-sha> --dry-run
   pnpm deploy:indexer:rollback <last-good-sha>
   ```

   - **Fast path** - the last-good deployment is still one of Envio's live
     deployments: the script re-promotes it directly. No resync; takes seconds.
   - **Slow path** - the deployment was pruned: the script requires the
     last-good SHA to be in `origin/envio` history, refuses to push while Envio
     already has 3 live deployments, then force-pushes the last-good SHA to the
     `envio` branch and prints the resync-then-promote checklist. Budget
     10-30+ minutes for the from-genesis resync. If Envio is at capacity,
     delete a stale non-prod deployment first
     ([envio.dev/app](https://envio.dev/app/mento-protocol/mento)).

3. Verify [monitoring.mento.org](https://monitoring.mento.org) loads data.

4. Roll forward later by promoting the fixed deployment:
   `pnpm deploy:indexer:promote <fixed-sha>`.

---

## Metrics Bridge Peg-Policy Bootstrap

`PEG_POLICY_URL` is optional raw runtime configuration for the protected,
versioned peg-policy artifact. The platform Terraform stack will own the Cloud
Run value when that artifact plane is provisioned; do not add or change it with
an ad hoc `gcloud run services update --set-env-vars` command. Until then, an
absent value intentionally leaves only the isolated peg poller dormant. Blank
or malformed values are reported through that loop's bounded error channel and
must not affect the primary Hasura polling loop or `/health`.

Every policy version must end in `-<32 lowercase hex>` matching the first 32
characters of the SHA-256 digest over its canonical content without the
`version` field. Canonicalization recursively sorts object keys by Unicode code
point, preserves array order, and hashes the compact JSON encoding. The runtime
and repository checks reject stale or reused suffixes before the bridge
acknowledges the version.

On an active-version change, retain the exact active object from the current
base branch as `previous`. The integrity check compares repository history and
rejects an unrelated predecessor. After the producer acknowledges the new
active version, a later change may remove `previous` without changing `active`;
it may not reintroduce or mutate that predecessor in place. Complete that ACK
cleanup before another active rollover; CI and the runtime reject chained
rollovers while `previous` remains populated.

The metrics-bridge image contains its service-local `peg-registry.json`
identity/topology data at the compiled loader's expected path. It never bakes
`alerts/rules/peg-thresholds.json` into the image: page-affecting thresholds are
fetched from the gated runtime artifact under
[ADR 0044](adr/0044-peg-thresholds-gated-rules-plane.md).

---

## Dashboard Deployment (Vercel)

**Vercel's native Git integration watches `main`** — every push that changes dashboard-affecting files triggers an automatic production deploy. Pushes that only touch unrelated directories (e.g. `terraform/`, `indexer-envio/`) are skipped by `ui-dashboard/scripts/vercel-ignore-build.sh`. PR preview deployments diff each push incrementally against that branch's previous preview deployment (falling back to the merge base with `origin/main` on a branch's first push). So a docs-only PR skips, and once a branch's dashboard change has been previewed, later non-dashboard commits on the same branch skip too instead of rebuilding the whole branch on every push.

`ui-dashboard/vercel.json` suppresses ordinary deployments for
`sentry-autofix/*` through `git.deploymentEnabled` (ADR 0036 Phase 2b, issue
#1452). Treat this source-controlled rule as workflow hygiene, not a secret
boundary: branch code can change it. Provider-owned deployment eligibility and
protection must reject untrusted code, and operators must not manually deploy
autofix branches. See [ADR 0019](adr/0019-vercel-path-aware-deploys.md).

The project is named `monitoring-dashboard` and lives at [monitoring.mento.org](https://monitoring.mento.org).

### Infrastructure (Terraform)

Terraform stack ownership is registered in [`terraform.stacks.json`](../terraform.stacks.json) and summarized in [`docs/terraform.md`](./terraform.md). The dashboard/platform stack lives in [`terraform/`](../terraform/). The team-level Vercel Blob store is managed through Vercel Storage and linked to the project outside Terraform. The platform stack covers:

- Vercel project creation and configuration (`root_directory`, Git integration)
- All Terraform-managed environment variables (Hasura URLs, Upstash Redis credentials)
- Custom domain (`monitoring.mento.org`)
- Upstash Redis database (dashboard-managed labels, reports, intelligence, and
  integration state)
- Monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, and CI WIF/IAM

The path-aware Vercel ignore command lives in
[`ui-dashboard/vercel.json`](../ui-dashboard/vercel.json), not Terraform, so the
script can be reviewed and tested with dashboard changes.

**State is stored remotely** in GCS at `gs://mento-terraform-tfstate-6ed6/monitoring-monorepo/`. No local backup is needed — GCS is the source of truth and has object versioning enabled.

#### Terraform commands

```bash
pnpm tf list       # show all registered Terraform stacks
pnpm infra:init    # first time, or after provider changes
pnpm infra:plan    # preview changes
pnpm infra:apply   # apply changes
```

Protocol Grafana alerts and global Grafana routing use the separate
`alerts-rules` stack (`pnpm alerts:rules:plan`), which also owns the Aegis
service-health alert rules. Event-driven alert delivery uses `alerts-delivery`
(`pnpm alerts:infra:plan`). Aegis dashboards use `aegis` (`pnpm aegis:tf:plan`).

### Key Environment Variables

Most env vars are managed by Terraform (set for `production` and `preview` targets). Do not edit Terraform-managed vars manually in the Vercel dashboard. The Blob store identity variables are managed by the Vercel Blob store integration and should not be added to Terraform.

Agent rule: never create or rotate dashboard, workflow, or platform secrets with
manual CLI commands (`gh secret set`, `vercel env add`, `gcloud secrets versions
add`, etc.). Add or update the owning Terraform resource/integration instead,
document the source of truth here, and wait for a human-approved plan/apply.

| Variable                              | Source                   | Description                                                           |
| ------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `ENABLE_EXPERIMENTAL_COREPACK`        | Terraform resource       | Vercel Corepack opt-in so hosted builds honor pnpm 11                 |
| `NEXT_PUBLIC_HASURA_URL`              | `terraform.tfvars`       | Prod Envio endpoint (Ethereum reserve-yield + Celo + Monad + Polygon) |
| `METRICS_BRIDGE_URL`                  | Terraform Cloud Run URI  | Server-only Metrics Bridge origin for the peg-monitoring proxy        |
| `NEXT_PUBLIC_HASURA_URL_TESTNET`      | `terraform.tfvars`       | Optional Monad Testnet Envio endpoint                                 |
| `NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA` | `terraform.tfvars`       | Optional Celo Sepolia Envio endpoint                                  |
| `NEXT_PUBLIC_SHOW_TESTNET_NETWORKS`   | `terraform.tfvars`       | Optional `true` flag that exposes hosted testnet networks             |
| `UPSTASH_REDIS_REST_URL`              | Terraform output         | Dashboard-managed Redis — auto-set from DB                            |
| `UPSTASH_REDIS_REST_TOKEN`            | Terraform output         | Dashboard-managed Redis token — auto-set                              |
| `BLOB_STORE_ID`                       | Vercel store integration | Blob OIDC store id for backup and restore routes                      |
| `BLOB_WEBHOOK_PUBLIC_KEY`             | Vercel store integration | Blob OIDC public key for the connected store                          |

Terraform derives `METRICS_BRIDGE_URL` from
`google_cloud_run_v2_service.metrics_bridge.uri`. A human-approved platform
plan and apply own the Vercel environment update, and the dashboard deployment
workflow owns the deployment that consumes it. The checked-in resource alone
does not activate the proxy in production.

### Aggregator Integration Probes

The `/integrations` dashboard page reads the latest quote-only probe snapshot
from Upstash key `integration-probes:latest`. The scheduled
`.github/workflows/integration-probes.yml` workflow refreshes it daily and can
also be run manually with `workflow_dispatch`. `integration-probes:latest`
expires after 3 days so missed scheduled probes surface as stale/missing
dashboard data; dated history keys expire after 90 days. Chain statuses are
`pass` only when every active USDm hub-pair direction passes and `partial` when
at least one direction passes but full coverage is still missing. Snapshots also
carry a 30d public volume signal for each aggregator when a stable public source
is available; this signal is rendered as context on `/integrations` and does not
affect health status.

```bash
pnpm integrations:probe
pnpm integrations:probe --write-upstash
pnpm integrations:probe --adapter openocean,relay --chain 42220 --pair-limit 1 --output .tmp/integration-probe-smoke.json
```

`INTEGRATION_PROBES_HASURA_URL` can override `NEXT_PUBLIC_HASURA_URL` for pool
discovery. `LIFI_API_KEY` authenticates LI.FI/Jumper quote probes with the
`x-lifi-api-key` header so scheduled runs avoid public quote limits,
`FLYTRADE_API_KEY` authenticates the Fly.trade follow-up requests behind Monad
LI.FI routes with the `apikey` header against `api.magpiefi.xyz` (falling back
to the public `api.fly.trade` origin when unset),
`OPENOCEAN_API_KEY` enables the OpenOcean Pro endpoint for OpenOcean checks,
and `SQUID_INTEGRATOR_ID` identifies Mento's Squid quote probes through the
`x-integrator-id` header. Squid Celo probes also read Uniswap V3 pool balances
through `SQUID_CELO_RPC_URL` when set, defaulting to Forno, to size discovery
amounts after the default quote. These are managed by the platform Terraform stack
from `lifi_api_key`, `flytrade_api_key`, `openocean_api_key`, and
`squid_integrator_id`. The same
platform stack mirrors
`INTEGRATION_PROBES_HASURA_URL`, `UPSTASH_REDIS_REST_URL`, and
`UPSTASH_REDIS_REST_TOKEN` into repo-level GitHub Actions secrets so scheduled
writers use the same Terraform-owned runtime as the dashboard. Adapter
credentials are optional at the stack level; missing keys render as `needs_key`
instead of failing the chain check.

LI.FI/Jumper checks start with the default nominal quote and then try
route-discovery variants with current LI.FI OpenOcean exchange filters and
larger stable-unit amounts. This catches integrations that can route through
Mento v3 even when small default swaps prefer cheaper non-Mento venues. A
discovered route still passes only when the response contains Routerv300 or
registered pool/VirtualPool address evidence. LI.FI quote attempts are capped
at 180 per scheduled run, and repeated request/HTTP errors are capped at two
attempts per route, so discovery cannot exhaust the API quota or starve the
scheduled writer before it publishes degraded results.
Budgeted adapters run pair probes serially so downstream evidence follow-ups
cannot be starved by other in-flight pair probes.

Monad LI.FI/Jumper routes can use Fly as the downstream provider. When LI.FI
returns `tool: "fly"`, the probe follows Fly's quote and distributions APIs and
uses only registered Mento v3 pool-address evidence from the Fly distributions
response as a pass. Celo LI.FI/Jumper probes stay on LI.FI response evidence;
they do not borrow Fly evidence for a chain where LI.FI has not exposed Fly.

### Address Book & Backup Cron

The dashboard includes a private address book at `/address-book` for labeling
wallet addresses with company or entity names. Labels, forensic reports, and
managed address/entity intelligence records live in the same Upstash instance.

A daily cron job at `03:00 UTC` (defined in `ui-dashboard/vercel.json`) backs up
seven managed hashes: labels, reports, and five intelligence hashes. It writes a
private v2 manifest plus one Vercel Blob per hash. Legacy v1 monolithic snapshots
remain restore-only. The user-facing `/api/address-labels/export` and
`/api/address-labels/import` routes use the separate `addresses` + `reports`
shape; they are not the v2 Blob format. This is not a whole-Redis backup:
Minipay sync state and TTL integration-probe snapshots remain outside it.

Backup and restore use Vercel Blob OIDC through the project-linked
`address-labels` store; do not configure a static `BLOB_READ_WRITE_TOKEN`. To
restore a private backup, call
`POST /api/address-labels/restore?pathname=<manifest-pathname>` with either a
workspace session or the `CRON_SECRET` bearer credential. The server-side
restore preserves trusted report provenance metadata. The team-level Blob store
survives project recreation.

### Security Posture — Preview Deployments

Preview deployments receive the **same** `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_SECRET` values as production. This is required by the Auth.js `redirectProxyUrl` flow (see [`terraform/dashboard.tf`](../terraform/dashboard.tf) auth block for the full rationale): Google OAuth callbacks land on the prod domain, and the signed state JWE must verify against the same `AUTH_SECRET` on both ends.

To make this safe, these controls must hold:

1. **Vercel SSO Deployment Protection** covers all previews and production
   deployment URLs. The protected Lighthouse path uses the project-scoped
   automation-bypass secret managed by Terraform.
2. **Git fork protection** prevents fork PRs from producing preview deployments.

The `sentry-autofix/*` rule in `ui-dashboard/vercel.json` also suppresses
ordinary machine-authored previews, but it is branch-controlled defense in
depth, not one of these trust-boundary controls.

If SSO or fork protection is loosened, or another untrusted branch class becomes
deployment-eligible, treat all three shared secrets as exposed:

- Rotate `AUTH_GOOGLE_SECRET` in GCP (OAuth consent screen) and update `terraform/terraform.tfvars`.
- Regenerate `AUTH_SECRET` (`openssl rand -base64 32`), update `terraform/terraform.tfvars`.
- Either split secrets across environments (requires reworking preview auth — different OAuth client + domain-local state, not redirectProxyUrl), or drop app-level auth from preview entirely (see commit `74e533f` for the prior bypass pattern that relied solely on Deployment Protection).

`CRON_SECRET` is scoped to production only — previews cannot forge Bearer auth against the prod `/api/address-labels/backup` endpoint even if the preview build is compromised.

---

## Initial Setup (Terraform)

Run this once when setting up from scratch or recreating the Vercel project.

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.7
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) — authenticated with ADC (`gcloud auth application-default login`). Your account needs `storage.objects.get`, `storage.objects.create`, and `storage.objects.list` on the `mento-terraform-tfstate-6ed6` GCS bucket (role: `roles/storage.objectUser` on the bucket, or broader project-level `roles/storage.admin`)
- [Vercel CLI](https://vercel.com/docs/cli) (for blob store creation)
- Vercel API token (create at [vercel.com/account/tokens](https://vercel.com/account/tokens))
- Upstash account + API key ([console.upstash.com → Account → API Keys](https://console.upstash.com/account/api))

### Steps

**1. Provision the Blob store (one-time — not manageable via Terraform)**

```bash
vercel blob create-store address-labels --scope mentolabs
```

Connect the store to `monitoring-dashboard` in the Vercel dashboard and use the Blob **Upgrade to OIDC** flow if the store was created before OIDC. The integration sets `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY` on the project. Do not add `BLOB_READ_WRITE_TOKEN` to production or preview; the dashboard backup and restore routes use the Vercel runtime identity.

**2. Delete the existing Vercel project (if recreating)**

```bash
vercel project rm monitoring-dashboard --scope mentolabs
```

**3. Fill in credentials**

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edit terraform/terraform.tfvars
```

**4. Init (+ one-time state migration if you have an existing local `terraform.tfstate`)**

```bash
pnpm infra:init
```

If a local `terraform/terraform.tfstate` was present from before the GCS backend was introduced, `terraform init` will detect it and prompt to migrate. Enter `yes` to copy it to GCS. This is a one-time step — afterwards GCS is authoritative and the local file can be deleted.

**5. Plan and review**

```bash
pnpm infra:plan
```

Read the complete plan and get explicit human approval before applying.

**6. Apply**

```bash
pnpm infra:apply
```

Terraform creates the Upstash Redis database, Vercel project,
Terraform-managed environment variables, custom domain, and
`.vercel/project.json`.

**7. Trigger first deploy**

Push a dashboard-affecting commit, or run the guarded manual deploy wrapper:

```bash
pnpm deploy:dashboard
```

The wrapper anchors the deploy at the monorepo root, checks that the worktree
is clean, verifies Vercel authentication, and uses the Terraform-written
`.vercel/project.json`. Do not run a raw deploy from `ui-dashboard/`; its
package directory does not match the Git integration's repository-root upload
layout.

---

## Branch Strategy

```text
main
├── 🚀 auto-deploys to Vercel (when dashboard-affecting inputs change)
└── feature branches → PR → main

envio
├── 🚀 auto-deploys to Envio (multichain indexer, Celo + Monad + Polygon)
└── updated via: pnpm deploy:indexer
```

**Why a deploy branch?** Dashboard changes are frequent → auto-deploy on `main` push. Indexer changes are rare → manual push to the `envio` branch avoids unnecessary Envio redeployments.

---

## Troubleshooting

### Deploy cancelled with "Ignored Build Step"

The dashboard project intentionally skips builds when no dashboard-affecting
files changed. The skip script is `ui-dashboard/scripts/vercel-ignore-build.sh`;
it watches `ui-dashboard/`, `shared-config/`, workspace dependency metadata,
and `.lighthouserc.cjs` so Lighthouse-required PRs receive a preview.
The script uses local Git metadata when available, then falls back to GitHub's
API when Vercel has stripped `.git` from the uploaded source. It tries three
anchors in order:

1. **PR preview deployments** — Vercel provides `VERCEL_GIT_PULL_REQUEST_ID`.
   When the branch already has a previous deployment (`VERCEL_GIT_PREVIOUS_SHA`),
   the script diffs incrementally from that SHA — locally or via GitHub compare —
   so intermediate pushes that don't touch the dashboard skip instead of
   rebuilding the whole branch. On the first push (no previous deployment) it
   diffs from the merge base with `origin/main`, or, without local Git metadata,
   from GitHub's paginated PR file list.
2. **First-push branch fallback** — when Vercel ships neither
   `VERCEL_GIT_PULL_REQUEST_ID` nor `VERCEL_GIT_PREVIOUS_SHA` (which happens
   when `git push` outruns `gh pr create`), the script falls back to the merge
   base with `origin/main` when local Git exists. Without local Git, it uses the
   GitHub compare API only for single-commit branch pushes; multi-commit branch
   fallbacks build to avoid false skips.
3. **Subsequent branch / production deployments** — `VERCEL_GIT_PREVIOUS_SHA`
   is set, so the script diffs from that SHA locally or through GitHub compare
   to keep the resource-saving behavior.

If the script cannot prove a deployment is dashboard-clean, it builds. For
env-only changes that require a fresh production runtime, run the guarded
manual deploy wrapper from the monorepo root:

```bash
pnpm deploy:dashboard
```

The wrapper always deploys from the correct root and refuses a dirty worktree.

### Envio deployment fails

Check build logs in the Envio dashboard → Build Logs tab. Common issues:

- `pnpm install` fails → verify `pnpm-lock.yaml` is committed
- Config file not found → verify `config.multichain.mainnet.yaml` exists in `indexer-envio/`
- TypeScript errors → run `pnpm indexer:codegen` locally first; for reserve-yield changes run `pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test`

### Indexer not syncing

Check Envio dashboard → Metrics tab.

- Stuck at 0% → check RPC URL in config
- RPC rate-limited → contact Envio for HyperSync support
- Start block wrong → use a block at or before the first relevant event; the
  configured Celo default is `60664500`

### Force a fresh Envio sync

Do not delete the production indexer ad hoc. A fresh deploy SHA creates an
independent deployment from the configured start blocks; use the status and
verification commands above before promotion. If an incident requires an
uncached rebuild, use Envio's dashboard cache controls or coordinate with Envio
support so the current production deployment remains available until its
replacement is verified.

### Terraform state recovery

State is in GCS (`gs://mento-terraform-tfstate-6ed6/monitoring-monorepo/`) with object versioning. To recover a previous state version, download an older object version from the GCS bucket and run `terraform state push <file>`.

If state is unrecoverable, import existing resources back with `terraform import`. Key resource addresses:

```bash
terraform import vercel_project.dashboard <project-id>
terraform import upstash_redis_database.address_labels <database-id>
terraform import vercel_project_domain.monitoring monitoring.mento.org
```
