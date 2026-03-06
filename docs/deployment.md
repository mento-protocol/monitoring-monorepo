# Deployment Guide

## Architecture

This monorepo deploys two services independently:

- **Indexer** (`indexer-envio/`) → Envio Hosted Service
- **Dashboard** (`ui-dashboard/`) → Vercel (`monitoring-dashboard` project)

---

## Indexer Deployment (Envio Hosted)

### Deploy Branches

Each network has a dedicated deploy branch that Envio watches:

| Network       | Deploy Branch          | Config File                 | Envio Project            |
| ------------- | ---------------------- | --------------------------- | ------------------------ |
| Celo Mainnet  | `deploy/celo-mainnet`  | `config.celo.mainnet.yaml`  | `mento-v3-celo-mainnet`  |
| Celo Sepolia  | `deploy/celo-sepolia`  | `config.celo.sepolia.yaml`  | `mento-v3-celo-sepolia`  |
| Monad Mainnet | `deploy/monad-mainnet` | `config.monad.mainnet.yaml` | `mento-v3-monad-mainnet` |

### Endpoint URLs

**Mainnet** uses the Envio **production** tier with a static endpoint — the hash does not change on redeployment:

```text
https://indexer.hyperindex.xyz/60ff18c/v1/graphql
```

**Sepolia** is on the Envio **dev** tier. The URL hash changes on every redeploy:

```text
https://indexer.hyperindex.xyz/<hash>/v1/graphql
```

After a Sepolia redeploy, update `NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED` in Vercel via `terraform apply`.

### Deployment Workflow

**Redeploy the mainnet indexer:**

```bash
# Push main to the deploy branch (triggers Envio redeploy)
pnpm deploy:indexer:mainnet
# equivalent: git push origin main:deploy/celo-mainnet
```

**Redeploy Sepolia:**

```bash
pnpm deploy:indexer:sepolia
# After Envio finishes syncing, update hasura_url_sepolia_hosted in
# terraform/terraform.tfvars and run: pnpm infra:apply
```

### Force Retrigger Without Code Changes

If Envio gets stuck or you need to retrigger without a code change:

```bash
# Empty commit trick
git commit --allow-empty -m "chore: retrigger envio deploy"
git push origin main:deploy/celo-mainnet
```

### Discord Notification

`.github/workflows/notify-envio-deploy.yml` fires automatically when you push to any `deploy/*` branch. It posts a reminder in Discord to update the Vercel endpoint after Envio finishes syncing.

### After Redeployment Checklist

1. ✅ Wait for Envio to reach 100% sync (check [envio.dev/app](https://envio.dev/app))
2. ✅ If Sepolia: get the new GraphQL endpoint URL from the Envio dashboard, update `hasura_url_sepolia_hosted` in `terraform/terraform.tfvars`, run `pnpm infra:apply`
3. ✅ Trigger a Vercel redeploy (or wait for next push to `main`)
4. ✅ Verify monitoring.mento.org loads data

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

**State is stored locally** in `terraform/terraform.tfstate` (gitignored). Back it up — losing it means re-importing resources.

#### Terraform commands

```bash
pnpm infra:init    # first time, or after provider changes
pnpm infra:plan    # preview changes
pnpm infra:apply   # apply changes
```

### Environment Variables

All env vars are managed by Terraform (set for `production` and `preview` targets). Do not edit them manually in the Vercel dashboard.

| Variable                                | Source             | Description                             |
| --------------------------------------- | ------------------ | --------------------------------------- |
| `NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED` | `terraform.tfvars` | Hasura endpoint — Celo Mainnet (hosted) |
| `NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED` | `terraform.tfvars` | Hasura endpoint — Celo Sepolia (hosted) |
| `NEXT_PUBLIC_HASURA_SECRET_*`           | `terraform.tfvars` | Hasura admin secrets (empty for Envio)  |
| `UPSTASH_REDIS_REST_URL`                | Terraform output   | Address labels Redis — auto-set from DB |
| `UPSTASH_REDIS_REST_TOKEN`              | Terraform output   | Address labels Redis token — auto-set   |
| `BLOB_READ_WRITE_TOKEN`                 | `terraform.tfvars` | Vercel Blob token for backup cron       |

### Address Book & Backup Cron

The dashboard includes a private address book at `/address-book` for labeling wallet addresses with company or entity names. Labels are stored in Upstash Redis and displayed inline throughout the UI.

A daily cron job at `03:00 UTC` (defined in `ui-dashboard/vercel.json`) snapshots all labels to Vercel Blob storage as a backup. The Blob store (`address-labels`) is a team-level resource — it survives project recreation.

---

## Initial Setup (Terraform)

Run this once when setting up from scratch or recreating the Vercel project.

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
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

**4. Apply**

```bash
pnpm infra:init
pnpm infra:apply
```

Terraform creates: Upstash Redis database + Vercel project + all env vars + custom domain + `.vercel/project.json`.

**5. Trigger first deploy**

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

deploy/celo-mainnet
├── 🚀 auto-deploys to Envio (indexer, mainnet)
└── updated via: pnpm deploy:indexer:mainnet

deploy/celo-sepolia
├── 🚀 auto-deploys to Envio (indexer, sepolia)
└── updated via: pnpm deploy:indexer:sepolia
```

**Why deploy branches?** Dashboard changes are frequent → auto-deploy on `main` push. Indexer changes are rare → manual push to deploy branch avoids unnecessary Envio redeployments (which change the endpoint hash, requiring a Terraform env var update).

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
- Config file not found → verify `config.celo.mainnet.yaml` exists in `indexer-envio/`
- TypeScript errors → run `pnpm indexer:mainnet:codegen` locally first

### Dashboard shows no data after indexer redeploy

The Sepolia endpoint hash changed. Update `hasura_url_sepolia_hosted` in `terraform/terraform.tfvars` and run `pnpm infra:apply`. Vercel will pick up the new env var on the next deploy.

### Indexer not syncing

Check Envio dashboard → Metrics tab.

- Stuck at 0% → check RPC URL in config
- RPC rate-limited → contact Envio for HyperSync support
- Start block wrong → must be ≤ first contract deployment block (`60664513` for mainnet)

### Force a fresh Envio sync

Delete the indexer in Envio dashboard → re-add it. This resets all state and starts from the configured start block.

### Terraform state lost

If `terraform/terraform.tfstate` is lost, import existing resources back with `terraform import`. Key resource addresses:

```bash
terraform import vercel_project.dashboard <project-id>
terraform import upstash_redis_database.address_labels <database-id>
terraform import vercel_project_domain.monitoring monitoring.mento.org
```
