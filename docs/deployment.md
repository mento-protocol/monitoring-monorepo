# Deployment Guide

## Architecture

This monorepo deploys two services independently:

- **Indexer** (`indexer-envio/`) → Envio Hosted Service
- **Dashboard** (`ui-dashboard/`) → Vercel (`monitoring-dashboard` project)

---

## Indexer Deployment (Envio Hosted)

### Deploy Branch

The prod multichain indexer is driven by a single deploy branch that Envio watches:

| Network                | Deploy Branch | Config File                      | Envio Project                  |
| ---------------------- | ------------- | -------------------------------- | ------------------------------ |
| Celo + Monad (mainnet) | `envio`       | `config.multichain.mainnet.yaml` | `mento-protocol/mento` (Envio) |

### Endpoint URL

The indexer runs on the Envio **production medium** tier with a static endpoint - the hash does not change on redeployment:

```text
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

### Deployment Workflow

**Redeploy the prod indexer:**

```bash
# Push main to the envio branch (triggers Envio redeploy)
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
# equivalent: git push origin main:envio
```

Then wait for the deployment to catch up and promote it:

```bash
pnpm deploy:indexer:status "$COMMIT" --watch
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
pnpm deploy:indexer:promote "$COMMIT"
```

### Force Retrigger Without Code Changes

If Envio gets stuck or you need to retrigger without a code change:

```bash
# Empty commit trick
git commit --allow-empty -m "chore: retrigger envio deploy"
git push origin main:envio
```

### After Redeployment Checklist

1. Wait for the deployed commit to register and catch up to the chain head (`pnpm deploy:indexer:status "$COMMIT" --watch` or [envio.dev/app](https://envio.dev/app)).
2. Inspect build and runtime errors with explicit commit-scoped logs (`pnpm deploy:indexer:logs "$COMMIT" --build` and `pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h`).
3. Promote the same caught-up commit (`pnpm deploy:indexer:promote "$COMMIT"`) so the static production endpoint serves it.
4. Trigger a Vercel redeploy only if dashboard code or GraphQL fields changed and the dashboard has not already deployed from `main`.
5. Verify monitoring.mento.org loads data.

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

---

## Dashboard Deployment (Vercel)

**Vercel's native Git integration watches `main`** — every push that changes dashboard-affecting files triggers an automatic production deploy. Pushes that only touch unrelated directories (e.g. `terraform/`, `indexer-envio/`) are skipped by `ui-dashboard/scripts/vercel-ignore-build.sh`. PR preview deployments compare the PR diff against `origin/main`, so docs-only PRs skip even when `main` has had dashboard changes since the last successful production deployment.

The project is named `monitoring-dashboard` and lives at [monitoring.mento.org](https://monitoring.mento.org).

### Infrastructure (Terraform)

Terraform stack ownership is registered in [`terraform.stacks.json`](../terraform.stacks.json) and summarized in [`docs/terraform.md`](./terraform.md). The dashboard/platform stack lives in [`terraform/`](../terraform/). The team-level Vercel Blob store is managed through Vercel Storage and linked to the project outside Terraform. The platform stack covers:

- Vercel project creation and configuration (`root_directory`, `ignore_command`, Git integration)
- All Terraform-managed environment variables (Hasura URLs, Upstash Redis credentials)
- Custom domain (`monitoring.mento.org`)
- Upstash Redis database (address labels storage)
- Monitoring GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Agent bootstrap, and CI WIF/IAM

**State is stored remotely** in GCS at `gs://mento-terraform-tfstate-6ed6/monitoring-monorepo/`. No local backup is needed — GCS is the source of truth and has object versioning enabled.

#### Terraform commands

```bash
pnpm tf list       # show all registered Terraform stacks
pnpm infra:init    # first time, or after provider changes
pnpm infra:plan    # preview changes
pnpm infra:apply   # apply changes
```

Protocol Grafana alerts and global Grafana routing use the separate
`alerts-rules` stack (`pnpm alerts:rules:plan`). Event-driven alert delivery
uses `alerts-delivery` (`pnpm alerts:infra:plan`). Aegis dashboards and
service-health alerts use `aegis` (`pnpm aegis:tf:plan`).

### Environment Variables

Most env vars are managed by Terraform (set for `production` and `preview` targets). Do not edit Terraform-managed vars manually in the Vercel dashboard. The Blob store identity variables are managed by the Vercel Blob store integration and should not be added to Terraform.

| Variable                   | Source                   | Description                                      |
| -------------------------- | ------------------------ | ------------------------------------------------ |
| `NEXT_PUBLIC_HASURA_URL`   | `terraform.tfvars`       | Prod Envio endpoint (Celo + Monad mainnet)       |
| `UPSTASH_REDIS_REST_URL`   | Terraform output         | Address labels Redis — auto-set from DB          |
| `UPSTASH_REDIS_REST_TOKEN` | Terraform output         | Address labels Redis token — auto-set            |
| `BLOB_STORE_ID`            | Vercel store integration | Blob OIDC store id for backup and restore routes |
| `BLOB_WEBHOOK_PUBLIC_KEY`  | Vercel store integration | Blob OIDC public key for the connected store     |

### Aggregator Integration Probes

The `/integrations` dashboard page reads the latest quote-only probe snapshot
from Upstash key `integration-probes:latest`. The scheduled
`.github/workflows/integration-probes.yml` workflow refreshes it daily and can
also be run manually with `workflow_dispatch`. `integration-probes:latest`
expires after 3 days so missed scheduled probes surface as stale/missing
dashboard data; dated history keys expire after 90 days.

```bash
pnpm integrations:probe
pnpm integrations:probe --write-upstash
pnpm integrations:probe --adapter openocean,relay --chain 42220 --pair-limit 1 --output .tmp/integration-probe-smoke.json
```

`INTEGRATION_PROBES_HASURA_URL` can override `NEXT_PUBLIC_HASURA_URL` for pool
discovery. `LIFI_API_KEY` is optional but recommended for scheduled runs because
the unauthenticated LI.FI quote API can return multi-hour public rate limits.
`OPENOCEAN_API_KEY` enables the OpenOcean Pro endpoint for OpenOcean checks and
is managed by the platform Terraform stack from `openocean_api_key`. Adapter
credentials are optional; missing keys render as `needs_key` instead of failing
the chain check.

### Address Book & Backup Cron

The dashboard includes a private address book at `/address-book` for labeling wallet addresses with company or entity names. Labels are stored in Upstash Redis and displayed inline throughout the UI. Forensic reports (long-form markdown investigations attached to an address) live in the same Upstash instance under the `reports` hash.

A daily cron job at `03:00 UTC` (defined in `ui-dashboard/vercel.json`) snapshots BOTH the labels hash AND the forensic-reports hash to Vercel Blob storage as a backup. The backup and restore routes use Vercel Blob OIDC through the project-linked `address-labels` store; do not configure a static `BLOB_READ_WRITE_TOKEN` for the dashboard project. The snapshot JSON has `addresses` (labels) and `reports` (forensic reports) keys side by side; the `/api/address-labels/import` route accepts the same shape for user-uploaded restores. For snapshots too large to upload through Vercel's request body limit, call `POST /api/address-labels/restore?pathname=<blob-pathname>` with either a workspace session or `Authorization: Bearer $CRON_SECRET`; this server-side Blob restore preserves report `authorEmail`, `createdAt`, `updatedAt`, `source`, and `version` metadata from trusted first-party backups. The Blob store (`address-labels`) is a team-level resource — it survives project recreation.

### Security Posture — Preview Deployments

Preview deployments receive the **same** `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_SECRET` values as production. This is required by the Auth.js `redirectProxyUrl` flow (see [`terraform/dashboard.tf`](../terraform/dashboard.tf) auth block for the full rationale): Google OAuth callbacks land on the prod domain, and the signed state JWE must verify against the same `AUTH_SECRET` on both ends.

To make this safe, two controls must hold:

1. **Vercel Deployment Protection** is enabled on the `monitoring-dashboard` project — only `mentolabs` team members can reach a preview URL (Project Settings → Deployment Protection → "All Deployments (except production)" → Standard Protection).
2. **Fork PRs do not produce preview deployments** — on by default for team accounts; verify under Project Settings → Git → "Deploy for Fork Pull Requests" is off.

If either control is ever loosened, treat all three shared secrets as exposed:

- Rotate `AUTH_GOOGLE_SECRET` in GCP (OAuth consent screen) and update `terraform/terraform.tfvars`.
- Regenerate `AUTH_SECRET` (`openssl rand -base64 32`), update `terraform/terraform.tfvars`.
- Either split secrets across environments (requires reworking preview auth — different OAuth client + domain-local state, not redirectProxyUrl), or drop app-level auth from preview entirely (see commit `74e533f` for the prior bypass pattern that relied solely on Deployment Protection).

`CRON_SECRET` is scoped to production only — previews cannot forge Bearer auth against the prod `/api/address-labels/backup` endpoint even if the preview build is compromised.

---

## Initial Setup (Terraform)

Run this once when setting up from scratch or recreating the Vercel project.

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
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

**5. Apply**

```bash
pnpm infra:apply
```

Terraform creates: Upstash Redis database + Vercel project + all env vars + custom domain + `.vercel/project.json`.

**6. Trigger first deploy**

Push any commit touching `ui-dashboard/`, or force via:

```bash
vercel deploy --prod --force --with-cache --archive=tgz --yes
```

Run manual dashboard deploys from the monorepo root, not from
`ui-dashboard/`. The Vercel project root directory is `ui-dashboard`, so the
CLI needs the repository root plus the tracked root `.vercelignore`; running
from the package directory can miss `vercel.json`, while running from the root
without `.vercelignore` can upload local caches and dependencies.

---

## Branch Strategy

```text
main
├── 🚀 auto-deploys to Vercel (dashboard, when ui-dashboard/ changes)
└── feature branches → PR → main

envio
├── 🚀 auto-deploys to Envio (multichain indexer, Celo + Monad mainnet)
└── updated via: pnpm deploy:indexer
```

**Why a deploy branch?** Dashboard changes are frequent → auto-deploy on `main` push. Indexer changes are rare → manual push to the `envio` branch avoids unnecessary Envio redeployments.

---

## Troubleshooting

### Deploy cancelled with "Ignored Build Step"

The dashboard project intentionally skips builds when no dashboard-affecting
files changed. The skip script is `ui-dashboard/scripts/vercel-ignore-build.sh`;
it watches `ui-dashboard/`, `shared-config/`, and workspace dependency metadata.
The script tries three anchors in order:

1. **PR preview deployments** — Vercel provides `VERCEL_GIT_PULL_REQUEST_ID`,
   and the script diffs from the merge base with `origin/main`.
2. **First-push branch fallback** — when Vercel ships neither
   `VERCEL_GIT_PULL_REQUEST_ID` nor `VERCEL_GIT_PREVIOUS_SHA` (which happens
   when `git push` outruns `gh pr create`), the script falls back to the
   merge base with `origin/main` as long as `VERCEL_GIT_COMMIT_REF` points
   at a non-`main` branch.
3. **Subsequent branch / production deployments** — `VERCEL_GIT_PREVIOUS_SHA`
   is set, so the script diffs from that SHA to keep the resource-saving
   behavior.

If a dashboard-affecting change was skipped, check that the relevant base
commit is present in the shallow clone. For env-only changes that require a
fresh production runtime, run the manual deploy from the monorepo root:

```bash
vercel deploy --prod --force --with-cache --archive=tgz --yes
```

Do not run that command from `ui-dashboard/`: the Vercel project already has
`root_directory = ui-dashboard`, so package-directory deploys do not match the
Git integration layout.

### Envio deployment fails

Check build logs in the Envio dashboard → Build Logs tab. Common issues:

- `pnpm install` fails → verify `pnpm-lock.yaml` is committed
- Config file not found → verify `config.multichain.mainnet.yaml` exists in `indexer-envio/`
- TypeScript errors → run `pnpm indexer:codegen` locally first

### Indexer not syncing

Check Envio dashboard → Metrics tab.

- Stuck at 0% → check RPC URL in config
- RPC rate-limited → contact Envio for HyperSync support
- Start block wrong → must be ≤ first contract deployment block (`60664513` for mainnet)

### Force a fresh Envio sync

Delete the indexer in Envio dashboard → re-add it. This resets all state and starts from the configured start block.

### Terraform state recovery

State is in GCS (`gs://mento-terraform-tfstate-6ed6/monitoring-monorepo/`) with object versioning. To recover a previous state version, download an older object version from the GCS bucket and run `terraform state push <file>`.

If state is unrecoverable, import existing resources back with `terraform import`. Key resource addresses:

```bash
terraform import vercel_project.dashboard <project-id>
terraform import upstash_redis_database.address_labels <database-id>
terraform import vercel_project_domain.monitoring monitoring.mento.org
```
