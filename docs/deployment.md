# Deployment Guide

## Architecture

This is a monorepo containing:
- **Indexer** (`indexer-envio/`) → Envio Hosted Service
- **Dashboard** (`ui-dashboard/`) → Vercel

To avoid unnecessary redeployments, we use **separate deploy branches** for the indexer.

---

## Indexer Deployment (Envio Hosted)

### Deploy Branches

Each network has a dedicated deploy branch that Envio watches:

| Network | Deploy Branch | Config File | Envio Project |
|---------|---------------|-------------|---------------|
| Celo Sepolia | `deploy/celo-sepolia` | `config.celo.sepolia.yaml` | `mento-v3-celo-sepolia` |
| Celo Mainnet | `deploy/celo-mainnet` | `config.celo.mainnet.yaml` | `mento-v3-celo-mainnet` |
| Monad Mainnet | `deploy/monad-mainnet` | `config.monad.mainnet.yaml` | `mento-v3-monad-mainnet` |

### Deployment Workflow

**Local Development:**
```bash
# Work on main as usual
pnpm indexer:sepolia:dev

# When ready to deploy indexer changes to Celo Sepolia:
./scripts/deploy-indexer.sh celo-sepolia
```

**Manual Deployment:**
```bash
# Push current main to the deploy branch
git push origin main:deploy/celo-sepolia

# Or push a specific commit
git push origin <commit-sha>:deploy/celo-sepolia
```

Envio will automatically redeploy when the deploy branch is updated.

### Initial Setup (one-time)

**1. Create Deploy Branches**
```bash
# Create all deploy branches from main
git push origin main:deploy/celo-sepolia
git push origin main:deploy/celo-mainnet
git push origin main:deploy/monad-mainnet
```

**2. Configure Envio Projects**

For each network, create an Envio hosted project:

1. Go to <https://envio.dev/app>
2. New Deployment → Connect GitHub repo `mento-protocol/monitoring-monorepo`
3. Fill in:
   - **Name:** `mento-v3-celo-sepolia` (or respective network)
   - **Description:** `Mento v3 indexer for Celo Sepolia`
   - **Directory:** `indexer-envio`
   - **Config File:** `config.celo.sepolia.yaml` (or respective config)
   - **Branch:** `deploy/celo-sepolia` (or respective branch)
   - **Plan:** Development (Free)
   - **Public:** ✅

4. Deploy

**3. Get GraphQL Endpoint**

After deployment, copy the GraphQL endpoint from Envio dashboard. Format:
```
https://<project-id>.envio.dev/v1/graphql
```

Add to Vercel env vars (see Dashboard Deployment below).

---

## Dashboard Deployment (Vercel)

### Deployment Workflow

**Vercel watches `main` branch** — every push to `main` triggers a dashboard redeploy.

Since dashboard changes are more frequent than indexer changes, this is the desired behavior.

### Initial Setup (one-time)

**1. Connect Vercel**
1. Go to <https://vercel.com/new>
2. Import `mento-protocol/monitoring-monorepo`
3. Configure:
   - **Framework:** Next.js
   - **Root Directory:** `ui-dashboard`
   - **Build Command:** `pnpm build` (default)
   - **Install Command:** `pnpm install` (default)

**2. Environment Variables**

Add these in Vercel project settings:

```bash
# Celo Sepolia (from Envio hosted)
NEXT_PUBLIC_HASURA_URL_SEPOLIA=https://<envio-project-id>.envio.dev/v1/graphql
NEXT_PUBLIC_HASURA_SECRET_SEPOLIA=  # Leave empty for hosted (no auth by default)
NEXT_PUBLIC_EXPLORER_URL_SEPOLIA=https://celo-sepolia.blockscout.com

# Celo DevNet (local/self-hosted)
NEXT_PUBLIC_HASURA_URL_DEVNET=http://localhost:8080/v1/graphql
NEXT_PUBLIC_HASURA_SECRET_DEVNET=testing
NEXT_PUBLIC_EXPLORER_URL_DEVNET=http://localhost:5100

# Future: Celo Mainnet
# NEXT_PUBLIC_HASURA_URL_MAINNET=https://<envio-mainnet-id>.envio.dev/v1/graphql
# NEXT_PUBLIC_HASURA_SECRET_MAINNET=
# NEXT_PUBLIC_EXPLORER_URL_MAINNET=https://explorer.celo.org
```

**3. Deploy**

Push to `main` — Vercel auto-deploys.

---

## Branch Strategy Summary

```
main
├── 🚀 auto-deploys to Vercel (dashboard)
└── feature branches → PR → main

deploy/celo-sepolia
├── 🚀 auto-deploys to Envio (indexer)
└── updated manually via: git push origin main:deploy/celo-sepolia

deploy/celo-mainnet
└── (future)

deploy/monad-mainnet
└── (future)
```

**Why?**
- Dashboard changes are frequent → auto-deploy on every `main` push
- Indexer changes are rare → manual push to deploy branch avoids unnecessary redeployments

---

## Troubleshooting

### Envio deployment fails

**Check logs in Envio dashboard** → Build Logs tab.

Common issues:
- `pnpm install` fails → check `package.json` / `pnpm-lock.yaml` are committed
- Config file not found → verify `config.celo.sepolia.yaml` exists in `indexer-envio/`
- TypeScript errors → run `pnpm indexer:sepolia:codegen` locally first

### Vercel deployment fails

**Check build logs in Vercel dashboard**.

Common issues:
- Missing env vars → add in Vercel project settings
- Build errors → run `pnpm --filter @mento-protocol/ui-dashboard build` locally first
- Wrong root directory → should be `ui-dashboard` not `.`

### Indexer not syncing

**Check Envio dashboard → Metrics tab**.

- If stuck at 0% → check RPC URL in config (for non-HyperSync networks)
- If RPC rate-limited → add fallback RPC or contact Envio for HyperSync support
- Check start block is correct (must be ≤ first contract deployment)

---

## Monitoring

**Indexer:**
- Envio dashboard → <https://envio.dev/app> → Metrics, Logs, Schema
- GraphQL playground: `https://<project-id>.envio.dev/v1/graphql`

**Dashboard:**
- Vercel dashboard → <https://vercel.com/dashboard>
- Production URL: auto-generated by Vercel (e.g., `mento-v3-monitoring.vercel.app`)

---

## Scripts

All deployment scripts live in `scripts/`:

```bash
./scripts/deploy-indexer.sh <network>
```

Example:
```bash
./scripts/deploy-indexer.sh celo-sepolia
```

This pushes `main` to `deploy/celo-sepolia` and triggers Envio redeployment.
