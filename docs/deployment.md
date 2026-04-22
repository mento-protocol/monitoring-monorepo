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

The indexer runs on the Envio **production** tier with a static endpoint — the hash does not change on redeployment:

```text
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

### Deployment Workflow

**Redeploy the prod indexer:**

```bash
# Push main to the envio branch (triggers Envio redeploy)
pnpm deploy:indexer
# equivalent: git push origin main:envio
```

### Force Retrigger Without Code Changes

If Envio gets stuck or you need to retrigger without a code change:

```bash
# Empty commit trick
git commit --allow-empty -m "chore: retrigger envio deploy"
git push origin main:envio
```

### After Redeployment Checklist

1. ✅ Wait for Envio to reach 100% sync (check [envio.dev/app](https://envio.dev/app))
2. ✅ Trigger a Vercel redeploy (or wait for next push to `main`)
3. ✅ Verify monitoring.mento.org loads data

---

## Dashboard Deployment (Vercel)

**Vercel's native Git integration watches `main`** — every push that changes files under `ui-dashboard/` triggers an automatic production deploy. Pushes that only touch other directories (e.g. `terraform/`, `indexer-envio/`) are skipped by the ignore command.

The project is named `monitoring-dashboard` and lives at [monitoring.mento.org](https://monitoring.mento.org).

### Infrastructure (Terraform)

All Vercel and storage infrastructure is managed by Terraform in [`terraform/`](../terraform/). This covers:

- Vercel project creation and configuration (`root_directory`, `ignore_command`, Git integration)
- All environment variables (Hasura URLs, Upstash Redis credentials, Blob token)
- Custom domain (`monitoring.mento.org`)
- Upstash Redis database (address labels storage)

**State is stored remotely** in GCS at `gs://mento-terraform-tfstate-6ed6/monitoring-monorepo/`. No local backup is needed — GCS is the source of truth and has object versioning enabled.

#### Terraform commands

```bash
pnpm infra:init    # first time, or after provider changes
pnpm infra:plan    # preview changes
pnpm infra:apply   # apply changes
```

### Environment Variables

All env vars are managed by Terraform (set for `production` and `preview` targets). Do not edit them manually in the Vercel dashboard.

| Variable                   | Source             | Description                                |
| -------------------------- | ------------------ | ------------------------------------------ |
| `NEXT_PUBLIC_HASURA_URL`   | `terraform.tfvars` | Prod Envio endpoint (Celo + Monad mainnet) |
| `UPSTASH_REDIS_REST_URL`   | Terraform output   | Address labels Redis — auto-set from DB    |
| `UPSTASH_REDIS_REST_TOKEN` | Terraform output   | Address labels Redis token — auto-set      |
| `BLOB_READ_WRITE_TOKEN`    | `terraform.tfvars` | Vercel Blob token for backup cron          |

### Address Book & Backup Cron

The dashboard includes a private address book at `/address-book` for labeling wallet addresses with company or entity names. Labels are stored in Upstash Redis and displayed inline throughout the UI.

A daily cron job at `03:00 UTC` (defined in `ui-dashboard/vercel.json`) snapshots all labels to Vercel Blob storage as a backup. The Blob store (`address-labels`) is a team-level resource — it survives project recreation.

### Security Posture — Preview Deployments

Preview deployments receive the **same** `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_SECRET` values as production. This is required by the Auth.js `redirectProxyUrl` flow (see [`terraform/main.tf`](../terraform/main.tf) auth block for the full rationale): Google OAuth callbacks land on the prod domain, and the signed state JWE must verify against the same `AUTH_SECRET` on both ends.

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

Copy the `BLOB_READ_WRITE_TOKEN` from the output (or retrieve it later from the Vercel dashboard → Storage).

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
vercel deploy --prod --force
```

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

The `ignore_command` (`git diff HEAD^ HEAD --quiet -- ui-dashboard`) cancelled the build because no `ui-dashboard/` files changed. This is correct behaviour for infra-only commits. To force a deploy:

```bash
vercel deploy --prod --force
```

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
