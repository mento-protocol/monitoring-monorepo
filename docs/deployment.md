# Deployment Guide

## Architecture

This monorepo deploys two services independently:

- **Indexer** (`indexer-envio/`) → Envio Hosted Service (free tier)
- **Dashboard** (`ui-dashboard/`) → Vercel

---

## Indexer Deployment (Envio Hosted)

### Deploy Branches

Each network has a dedicated deploy branch that Envio watches:

| Network       | Deploy Branch          | Config File                  | Envio Project            |
| ------------- | ---------------------- | ---------------------------- | ------------------------ |
| Celo Mainnet  | `deploy/celo-mainnet`  | `config.celo.mainnet.yaml`   | `mento-v3-celo-mainnet`  |
| Celo Sepolia  | `deploy/celo-sepolia`  | `config.celo.sepolia.yaml`   | `mento-v3-celo-sepolia`  |
| Monad Mainnet | `deploy/monad-mainnet` | `config.monad.mainnet.yaml`  | `mento-v3-monad-mainnet` |

### ⚠️ Endpoint Hash Changes on Every Deploy

Envio's free tier generates a **new GraphQL endpoint URL** on each deployment. The URL contains a hash that changes:

```text
https://indexer.dev.hyperindex.xyz/<hash>/v1/graphql
```

After every indexer redeploy, you **must** update the Vercel environment variable.

### Deployment Workflow

**Redeploy the mainnet indexer:**

```bash
# Push main to the deploy branch (triggers Envio redeploy)
pnpm deploy:indexer:mainnet
# equivalent: git push origin main:deploy/celo-mainnet

# After Envio finishes syncing, update the Vercel env var:
pnpm update-endpoint:mainnet
```

**Redeploy Sepolia:**

```bash
pnpm deploy:indexer:sepolia
pnpm update-endpoint:sepolia
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
2. ✅ Get the new GraphQL endpoint URL from the Envio dashboard
3. ✅ Run `pnpm update-endpoint:mainnet` (or update Vercel env var manually)
4. ✅ Trigger a Vercel redeploy (or wait for next push to `main`)
5. ✅ Verify monitoring.mento.org loads data

---

## Dashboard Deployment (Vercel)

**Vercel watches `main`** — every push to `main` triggers a dashboard redeploy automatically.

### Environment Variables (Vercel Project Settings)

```bash
# Celo Mainnet — hosted indexer (update after each indexer redeploy)
NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED=https://indexer.dev.hyperindex.xyz/<hash>/v1/graphql
NEXT_PUBLIC_HASURA_SECRET_MAINNET_HOSTED=  # empty for hosted (no auth by default)
NEXT_PUBLIC_EXPLORER_URL_MAINNET=https://explorer.celo.org

# Celo Sepolia — hosted indexer
NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED=https://indexer.dev.hyperindex.xyz/<hash>/v1/graphql
NEXT_PUBLIC_HASURA_SECRET_SEPOLIA_HOSTED=
NEXT_PUBLIC_EXPLORER_URL_SEPOLIA=https://celo-sepolia.blockscout.com
```

### update-endpoint Script

`pnpm update-endpoint:mainnet` uses the Vercel API to update `NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED` programmatically:

```bash
# Requires VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID in the environment
# (set via GitHub secrets during initial setup, or in local .env)
pnpm update-endpoint:mainnet <new-endpoint-url>
```

---

## Initial Setup (One-time)

### 1. Envio Setup

1. Go to [envio.dev/app](https://envio.dev/app) → New Deployment
2. Connect `mento-protocol/monitoring-monorepo`
3. Configure:
   - **Directory:** `indexer-envio`
   - **Config File:** `config.celo.mainnet.yaml`
   - **Branch:** `deploy/celo-mainnet`
   - **Plan:** Development (Free)
4. Deploy and note the GraphQL endpoint URL

### 2. Vercel Setup

1. Go to [vercel.com/new](https://vercel.com/new) → Import `mento-protocol/monitoring-monorepo`
2. Configure:
   - **Framework:** Next.js
   - **Root Directory:** `ui-dashboard`
3. Add all `NEXT_PUBLIC_*` env vars (see above)
4. Add GitHub secrets for deploy scripts:

```bash
pnpm deploy:dashboard:setup
# Sets: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID
```

---

## Branch Strategy

```text
main
├── 🚀 auto-deploys to Vercel (dashboard)
└── feature branches → PR → main

deploy/celo-mainnet
├── 🚀 auto-deploys to Envio (indexer, mainnet)
└── updated via: pnpm deploy:indexer:mainnet

deploy/celo-sepolia
├── 🚀 auto-deploys to Envio (indexer, sepolia)
└── updated via: pnpm deploy:indexer:sepolia
```

**Why deploy branches?** Dashboard changes are frequent → auto-deploy on `main` push. Indexer changes are rare → manual push to deploy branch avoids unnecessary Envio redeployments (which change the endpoint hash, requiring a Vercel env var update).

---

## Troubleshooting

### Envio deployment fails

Check build logs in the Envio dashboard → Build Logs tab. Common issues:

- `pnpm install` fails → verify `pnpm-lock.yaml` is committed
- Config file not found → verify `config.celo.mainnet.yaml` exists in `indexer-envio/`
- TypeScript errors → run `pnpm indexer:mainnet:codegen` locally first

### Dashboard shows no data after indexer redeploy

The endpoint hash changed. Run `pnpm update-endpoint:mainnet` with the new URL, then trigger a Vercel redeploy.

### Indexer not syncing

Check Envio dashboard → Metrics tab.

- Stuck at 0% → check RPC URL in config
- RPC rate-limited → contact Envio for HyperSync support
- Start block wrong → must be ≤ first contract deployment block (`60664513` for mainnet)

### Force a fresh Envio sync

Delete the indexer in Envio dashboard → re-add it. This resets all state and starts from the configured start block.
