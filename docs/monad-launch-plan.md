# Monad Monitoring — Launch Runbook

> **Status:** Code complete (PR #62 merged). Waiting on Envio hosted deployments.
>
> **Chains:** Monad Mainnet (143) · Monad Testnet (10143)

---

## What's Already Done (PR #62)

All code changes are merged into `main`. No further implementation is needed.

| Component                                          | What was done                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `shared-config/deployment-namespaces.json`         | Added `143 → mainnet`, `10143 → testnet-v2-rc5`                                                        |
| `@mento-protocol/contracts`                        | Bumped to **v0.3.0** — ships addresses for both Monad chains                                           |
| `indexer-envio/src/rpc.ts`                         | `DEFAULT_RPC_BY_CHAIN` map — chain 143 → Envio HyperRPC, chain 10143 → Envio HyperRPC                  |
| `indexer-envio/config.monad.mainnet.yaml`          | Envio config for mainnet, start block 60730000                                                         |
| `indexer-envio/config.monad.testnet.yaml`          | Envio config for testnet, start block 17932300, 3 pools wired                                          |
| `ui-dashboard/src/lib/networks.ts`                 | `monad-mainnet` + `monad-testnet` network definitions                                                  |
| `ui-dashboard/src/components/network-selector.tsx` | Networks hidden until `NEXT_PUBLIC_HASURA_URL_MONAD_*` is set                                          |
| `ui-dashboard/src/components/network-provider.tsx` | `isConfiguredNetworkId()` guards URL routing — `?network=monad-*` falls back to default when URL unset |
| `terraform/`                                       | Needs updates (see Step 3 below)                                                                       |
| `scripts/deploy-indexer.sh`                        | `pnpm deploy:indexer [network]` — run without args to be prompted                                      |
| CI                                                 | Codegen validates all 4 configs; `shared-config/**` triggers indexer checks                            |

---

## Chain Info

| Field                                   | Mainnet                                          | Testnet                                            |
| --------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Chain ID                                | **143**                                          | **10143**                                          |
| HyperSync                               | `https://143.hypersync.xyz`                      | `https://10143.hypersync.xyz`                      |
| Indexer RPC                             | `https://143.rpc.hypersync.xyz` (Envio HyperRPC) | `https://10143.rpc.hypersync.xyz` (Envio HyperRPC) |
| Block explorer                          | `https://monadscan.com`                          | `https://testnet.monadscan.com`                    |
| Namespace (`@mento-protocol/contracts`) | `mainnet`                                        | `testnet-v2-rc5`                                   |

### Contract Addresses

| Contract      | Mainnet (143)                                | Testnet (10143)                                                                                                                            |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| USDm          | `0xBC69212B8E4d445b2307C9D32dD68E2A4Df00115` | `0x5eCc03111ad2A78F981A108759bc73BAE2AB31bc`                                                                                               |
| SortedOracles | `0x6f92C745346057a61b259579256159458a0a6A92` | `0x85ed9ac57827132B8F60938F3165BC139E1F53cd`                                                                                               |
| FPMMFactory   | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b` | `0x353ED52bF8482027C0e0b9e3c0e5d96A9F680980`                                                                                               |
| Testnet pools | —                                            | `0xd9e9e6f6b5298e8bad390f7748035c49d6eeb055` · `0x1229e8a7b266c6db52712ba5c6899a6c4c3025cd` · `0x6d4c4b663541bf21015afb22669b0e1bbb3e2b1c` |

---

## Go-Live Checklist

### Monad Testnet (3 pools already deployed — ready now)

#### Step 1 — Create Envio hosted project (one-time, manual, ~5 min)

1. Go to <https://envio.dev/app/mento-protocol> → **New Indexer** → **Import from GitHub**
2. Select `mento-protocol/monitoring-monorepo`
3. Set:
   - **Branch:** `deploy/monad-testnet`
   - **Root directory:** `indexer-envio`
   - **Config file:** `config.monad.testnet.yaml`
   - **Project name:** `mento-v3-monad-testnet`
4. Create — Envio gives you a GraphQL endpoint: `https://indexer.hyperindex.xyz/<hash>/v1/graphql`
5. **Copy the URL** — needed in Step 3

#### Step 2 — Deploy the indexer (~2 min)

```bash
git checkout main && git pull
pnpm deploy:indexer monad-testnet
# equivalent: git push origin main:deploy/monad-testnet
```

Wait for Envio to reach 100% sync at <https://envio.dev/app/mento-protocol/mento-v3-monad-testnet>.
Testnet start block is 17,932,300 — sync should be fast.

#### Step 3 — Add Terraform variables (~10 min)

Add to `terraform/variables.tf`:

```hcl
variable "hasura_url_monad_testnet" {
  description = "Hasura GraphQL endpoint for Monad Testnet (Envio)"
  type        = string
  default     = ""
}
```

Add to `terraform/terraform.tfvars`:

```hcl
hasura_url_monad_testnet = "https://indexer.hyperindex.xyz/<hash>/v1/graphql"
```

Add to `terraform/main.tf` (same pattern as the Sepolia block):

```hcl
resource "vercel_project_environment_variable" "hasura_url_monad_testnet" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET"
  value      = var.hasura_url_monad_testnet
  target     = ["production", "preview"]
}
```

Then apply:

```bash
pnpm infra:plan   # preview
pnpm infra:apply  # apply → sets NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET in Vercel
```

#### Step 4 — Verify (~5 min)

- Go to <https://monitoring.mento.org> → network selector shows **Monad Testnet**
- Pools table shows 3 pools
- Oracle prices and health status render correctly
- Explorer links point to `testnet.monadscan.com`

---

### Monad Mainnet (no pools yet — indexer ready, nothing to index)

Run the same 4-step flow as testnet once the first pool is deployed via `CreateFPMM`.

Differences from testnet:

- Envio project name: `mento-v3-monad-mainnet`
- Deploy branch: `deploy/monad-mainnet` (`pnpm deploy:indexer monad-mainnet`)
- Terraform var: `hasura_url_multichain` → `NEXT_PUBLIC_HASURA_URL_MULTICHAIN` (shared with Celo Mainnet)
- Start block: 60,730,000 (SortedOracles deployed ~60,733,096)
- No pools in the config yet — the indexer will catch `FPMMDeployed` events and add them automatically

> ⚠️ **Note:** Monad mainnet pools have no `VirtualPool` support (only FPMM). `VirtualPoolFactory` is not in the `@mento-protocol/contracts` package for Monad yet — omitted from the config intentionally.

---

## Local Smoke Test (before deploying)

```bash
# 1. Run codegen against the Monad config first
cd indexer-envio
pnpm run envio:codegen --config config.monad.testnet.yaml

# 2. Spin up Envio locally
pnpm run dev:monad-testnet
# or: ./scripts/run-envio-with-env.mjs config.monad.testnet.yaml

# 3. Run the dashboard against the local indexer
cd ui-dashboard
NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET=http://localhost:8080/v1/graphql pnpm dev
# Visit http://localhost:3000 → select "Monad Testnet"
# Verify: pools visible, health badges render, oracle prices shown
```

---

## Post-Deploy Verification Checklist

- [ ] Monad Testnet visible in network selector
- [ ] "All Pools" table shows 3 pools
- [ ] Health status column has values (not all "N/A")
- [ ] Oracle price visible and non-zero for at least 1 pool
- [ ] TVL tile shows non-zero value
- [ ] Explorer links go to `testnet.monadscan.com`
- [ ] No console errors in browser

---

## Estimated Time

| Step                          | Effort                                              |
| ----------------------------- | --------------------------------------------------- |
| Create Envio project (manual) | ~5 min                                              |
| Deploy indexer                | ~2 min                                              |
| Terraform changes + apply     | ~10 min                                             |
| Wait for indexer sync         | ~15–30 min (testnet, ~350k blocks from start block) |
| Smoke test + verification     | ~10 min                                             |
| **Total**                     | **~1 hour**                                         |
