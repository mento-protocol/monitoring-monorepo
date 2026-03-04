---
title: "Envio Hosted Service Migration Plan"
date: 2026-03-04
type: research
tags: [mento, envio, indexer, deployment, vercel]
status: complete
---

# Envio Hosted Service Migration Plan

## TL;DR

Envio's hosted service uses **Git-based deployments** (like Vercel) — push to a branch, it deploys. No `envio deploy` CLI command exists. Free dev tier has limits (100k events, 5GB, 30-day max). The hosted service provides a **GraphQL endpoint** directly (no separate Hasura needed). Migration is straightforward: push indexer code to GitHub, connect via Envio dashboard, update Vercel env vars to point to the new endpoint.

---

## 1. How to Deploy (Git-based, No CLI)

There is **no `envio deploy` command**. Deployment is entirely Git-based via the Envio web dashboard:

1. **Login:** Go to [envio.dev/app/login](https://envio.dev/app/login), authenticate with GitHub
2. **Install GitHub App:** Grant the "Envio Deployments" GitHub App access to your repo
3. **Add Indexer:** Click "Add Indexer" in dashboard, select repo
4. **Configure:**
   - Config file path (e.g., `config.sepolia.yaml`)
   - Root directory (for monorepos)
   - Deployment branch (e.g., `deploy/envio` or `main`)
5. **Push to branch → auto-deploys**

### Requirements
- HyperIndex ≥ v2.21.5 (we're on v2.32.3 ✅)
- Versions 2.29.x are **not supported**
- `package.json` must be present
- Compatible with pnpm 9.10.0
- Repo ≤ 100MB

## 2. Hosted GraphQL Endpoint

### Format
```
https://{indexer-slug}.envio.dev/graphql
```
(Exact URL shown in dashboard after deployment)

### Authentication
- **Hosted indexers don't need an `ENVIO_API_TOKEN`** — HyperSync auth is handled automatically
- GraphQL endpoint access can be controlled via **IP/Domain whitelisting** in the dashboard (Security settings)
- No API key headers needed for querying the GraphQL endpoint by default

### Key Difference from Local
- **Local:** Queries go to Hasura (`http://localhost:8080/v1/graphql`)
- **Hosted:** Queries go directly to Envio's GraphQL endpoint — **no separate Hasura layer**
- The query schema/syntax should be identical (Envio uses Hasura under the hood)

## 3. Config Differences: Local vs Hosted

The `config.sepolia.yaml` should work **as-is** on hosted. Key notes:

- **RPC URL:** Your existing `https://forno.celo-sepolia.celo-testnet.org` will work, but Envio hosted service uses HyperSync by default for supported chains. Celo Sepolia may or may not have HyperSync support — the config's RPC will be used as fallback regardless.
- **Environment variables** on hosted must be prefixed with `ENVIO_` and set in the dashboard's Environment Variables tab
- **No Docker/local DB config needed** — Envio manages all infrastructure

## 4. Pricing / Free Tier

### Development Plan (Free)
- 3 indexers per org
- 3 deployments per indexer
- **Soft limits** (triggers 7+3 day deletion countdown):
  - 100,000 events processed
  - 5GB storage
  - No requests for 7 days
- **Hard limits** (immediate deletion):
  - 20GB storage
  - 30 days old
- Includes: GraphQL API, multichain, monitoring, alerts, IP whitelisting

### Paid Plans
- Production Small/Medium/Large and Dedicated tiers available
- See [envio.dev/pricing](https://envio.dev/pricing) for current rates

### For Our Use Case
With 12 events indexed and no trades yet, the free tier is **more than sufficient**. The 100k event soft limit and 30-day expiry are the main constraints to watch as we scale.

## 5. Dashboard Env Var Changes for Vercel

### Current (Local)
```env
NEXT_PUBLIC_HASURA_URL=http://localhost:8080/v1/graphql
```

### After Migration (Hosted)
```env
NEXT_PUBLIC_GRAPHQL_URL=https://{your-indexer}.envio.dev/graphql
```

Consider renaming the env var from `HASURA_URL` to `GRAPHQL_URL` since it's no longer Hasura directly. Update the GraphQL client initialization in the dashboard code accordingly.

## 6. CORS: Vercel → Envio Hosted

**Yes, it works.** Envio's hosted service is designed for exactly this pattern — frontend apps querying the GraphQL endpoint. They provide **Domain whitelisting** in the Security settings to restrict access to your Vercel domain(s) if desired.

No special CORS headers needed from your side.

## 7. Local Dev Alongside Hosted Prod

**Yes, absolutely.** This is the intended workflow:

- **Local:** `envio dev` with Docker/Hasura for development and testing
- **Hosted:** Push to deployment branch for production
- Use different env vars in Vercel:
  - Preview deployments → local or a separate hosted dev indexer
  - Production → hosted prod indexer

The config file is the same. No code changes needed between environments — only the GraphQL endpoint URL differs.

## 8. Step-by-Step Migration Plan

### Day 1 (Today — March 4): Prep

| Step | Task | Time |
|------|------|------|
| 1 | Ensure indexer code is in a GitHub repo (gisk0 org) | 5 min |
| 2 | Verify `package.json` exists with HyperIndex dep ≥2.21.5 | 2 min |
| 3 | Test `pnpm install` works with pnpm 9.10.0 | 5 min |
| 4 | Create deployment branch (e.g., `deploy/hosted`) | 2 min |

### Day 1 (Today): Deploy to Envio Hosted

| Step | Task | Time |
|------|------|------|
| 5 | Login to [envio.dev/app](https://envio.dev/app/login) with GitHub | 2 min |
| 6 | Install Envio Deployments GitHub App on repo | 2 min |
| 7 | Add indexer → select repo → set config path to `config.sepolia.yaml` | 3 min |
| 8 | Set deployment branch to `deploy/hosted` | 1 min |
| 9 | Push to `deploy/hosted` → watch deployment in dashboard | 5-15 min |
| 10 | Verify indexer syncs and events appear | 5 min |
| 11 | Note the GraphQL endpoint URL from dashboard | 1 min |
| 12 | Test a query against the hosted endpoint (curl or GraphQL playground) | 5 min |

### Day 1 (Today): Update Dashboard

| Step | Task | Time |
|------|------|------|
| 13 | Update GraphQL client code to use `NEXT_PUBLIC_GRAPHQL_URL` env var | 10 min |
| 14 | Test locally with hosted endpoint | 5 min |
| 15 | Add `NEXT_PUBLIC_GRAPHQL_URL` to Vercel env vars (production) | 2 min |
| 16 | Deploy dashboard to Vercel | 5 min |
| 17 | Verify dashboard loads data from hosted Envio | 5 min |

### Post-Deploy

- Set up alerts in Envio dashboard (Slack/Discord notifications)
- Configure domain whitelisting for the Vercel domain
- Monitor the 100k event limit — plan upgrade before hitting it
- Note 30-day auto-deletion on free tier — redeploy or upgrade before expiry

**Total estimated time: ~1-2 hours**

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Free tier 30-day expiry | Calendar reminder at day 25; upgrade to paid or redeploy |
| 100k event limit | Monitor in dashboard; upgrade when approaching 80k |
| Celo Sepolia not on HyperSync | Falls back to RPC automatically; may be slower |
| Schema differences | Unlikely — same Hasura-based GraphQL; test queries first |
| Deployment fails | Check pnpm compatibility, config path, repo size |

## 10. Quick Reference

```bash
# Local dev (unchanged)
envio dev

# Deploy to hosted (just push)
git push origin deploy/hosted

# Test hosted endpoint
curl -X POST https://{slug}.envio.dev/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ Pool(limit: 5) { id tokenA tokenB } }"}'
```

---

**Sources:**
- [Envio Hosted Service Overview](https://docs.envio.dev/docs/HyperIndex/hosted-service)
- [Deployment Guide](https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment)
- [Billing & Pricing](https://docs.envio.dev/docs/HyperIndex/hosted-service-billing)
- [CLI Commands](https://docs.envio.dev/docs/HyperIndex/cli-commands)
