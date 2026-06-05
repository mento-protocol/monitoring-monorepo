---
title: Integration Probes Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-06-01
---

# integration-probes

`@mento-protocol/integration-probes` runs quote-only checks against DEX
aggregators and cross-chain routers. It publishes the latest snapshot to
Upstash Redis for the dashboard `/integrations` page.

## Commands

```bash
pnpm integrations:probe
pnpm integrations:probe --write-upstash
pnpm integrations:probe --adapter openocean,relay --chain 42220 --pair-limit 1 --output .tmp/integration-probe-smoke.json
pnpm integrations:probe:test
pnpm --filter @mento-protocol/integration-probes typecheck
pnpm --filter @mento-protocol/integration-probes lint
pnpm --filter @mento-protocol/integration-probes knip
```

## Probe Rules

- Never mark a route `pass` from a source label alone. A pass requires
  Routerv300 or registered v3 pool/VirtualPool address evidence.
- Chain-level coverage is `partial` when at least one pair direction passes
  but the chain does not have full active USDm hub-pair coverage.
- Missing adapter credentials must return `needs_key`, not `fail`.
- Unsupported chain coverage must return `unsupported`, not `fail`.
- Quote probes are read-only. Do not add funded canary swaps without a new
  design review.
- Active stablecoin coverage comes from indexed USDm hub-pair pools when a
  Hasura URL is configured. Contract metadata fallback is for dry-run
  visibility only.
- LI.FI/Jumper probes use ordered route-discovery attempts after the default
  quote so cheaper non-Mento venues on small swaps do not mask an available
  Mento v3 route. Discovery uses current LI.FI tool keys only; do not add
  speculative `allowExchanges` values that are absent from `/v1/tools`. These
  attempts still pass only with Routerv300 or registered pool/VirtualPool
  address evidence.
- Monad LI.FI quotes can delegate to Fly. When LI.FI returns `tool: "fly"`,
  follow Fly's quote and distributions APIs and pass only if the distributions
  response exposes a registered Mento v3 pool address. Celo LI.FI checks do not
  use Fly fallback evidence; they must return direct Mento address evidence.
- LI.FI quote attempts are capped at 180 per scheduled run, and repeated
  request/HTTP errors during route discovery are capped at two attempts per
  route, so an aggregator outage or discovery loop cannot starve the scheduled
  writer. Budgeted adapters run pair probes serially so downstream follow-up
  requests, such as LI.FI-to-Fly evidence checks, cannot be starved by other
  in-flight pair probes.
- Squid quote probes are capped and paced between requests because bursty
  route checks can trigger 429s. Do not remove or lower the request delay
  without live route evidence that the scheduled probe remains healthy.
- Squid Celo probes use Mento reserve metadata plus the current official
  Uniswap V3 Celo pool sell-side balance, when RPC is available, to size a
  small discovery ladder after the default quote. This is only for amount
  selection; a pass still requires Mento v3 router or registered pool evidence.
- Adapter order is dashboard display order. Keep LI.FI, Squid, and OpenOcean
  first by operator priority, then sort remaining adapters by current public
  30d aggregator/bridge volume where available.
- `integration-probes:latest` expires after 3 days so failed scheduled probes
  degrade the dashboard instead of showing stale health forever. Dated history
  keys expire after 90 days.

## Env Vars

- `INTEGRATION_PROBES_HASURA_URL` overrides `NEXT_PUBLIC_HASURA_URL` for the
  pool discovery query.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required only
  when writing snapshots.
- Adapter credentials are optional at the infrastructure layer and should
  surface as `needs_key` when missing: `LIFI_API_KEY`, `OPENOCEAN_API_KEY`,
  `ZEROX_API_KEY`, `ONEINCH_API_KEY`, `SQUID_INTEGRATOR_ID`,
  `SOCKET_API_KEY`, `RANGO_API_KEY`, `OKX_DEX_API_KEY`, `OKX_DEX_SECRET`, and
  `OKX_DEX_PASSPHRASE`.
- `LIFI_API_KEY` authenticates LI.FI/Jumper quote probes with
  `x-lifi-api-key`; keep it server-side and Terraform-managed.
- `SQUID_INTEGRATOR_ID` authenticates Squid quote probes with
  `x-integrator-id`; keep it server-side and Terraform-managed.
- `SQUID_CELO_RPC_URL` optionally overrides the default Forno Celo RPC used for
  Squid Uniswap-liquidity discovery sizing. It is not a credential.
