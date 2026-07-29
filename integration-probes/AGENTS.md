---
title: Integration Probes Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
doc_type: agent-instructions
scope: integration-probes
review_interval_days: 90
garden_lane: agent-entry-points
---

# integration-probes

> **Architecture decisions** for this package live in [`docs/adr/`](../docs/adr/README.md) (scope: `integration-probes`) — read the relevant ADR before changing how something here is built; it records the _why_ the code can't.

`@mento-protocol/integration-probes` runs quote-only checks against DEX
aggregators and cross-chain routers. It publishes the latest snapshot to
Upstash Redis for the dashboard `/integrations` page. The default mainnet
probe fleet is Celo (42220), Monad (143), and Polygon (137).

Apply
[`docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md)
when probe snapshot changes propagate through Upstash into the dashboard.

## Commands

```bash
pnpm integrations:probe
pnpm integrations:probe --write-upstash
pnpm integrations:probe --adapter openocean,relay --chain 42220 --pair-limit 1 --output .tmp/integration-probe-smoke.json
pnpm integrations:probe --adapter openocean,kyberswap --chain 137 --pair-limit 1 --output .tmp/integration-probe-polygon-smoke.json
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
- Per-run request budgets, the per-route discovery error cap, and serial pair
  probes for budgeted adapters are load-bearing anti-starvation guards; do not
  loosen them without live scheduled-probe evidence.
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
- Adapter tiers are manually assigned priority buckets, not automatic volume
  ranks. Tier 1 requires current Celo support plus strategic/operator priority;
  aggregators that do not support Celo must not be Tier 1. Tier 2 covers
  meaningful candidates, high-volume venues missing Celo support, or incomplete
  integrations. Tier 3 is parked, excluded, or exploratory coverage.
- Volume signals are 30d public USD figures for dashboard context only. Prefer
  DefiLlama DEX aggregator or bridge-aggregator data when available, record the
  source category, and degrade to a null value rather than scraping fragile
  frontend-only stats.
- `integration-probes:latest` expires after 3 days so failed scheduled probes
  degrade the dashboard instead of showing stale health forever. Dated history
  keys expire after 90 days.
- Adapter credentials are optional and must surface as `needs_key` when
  missing. Keep every key server-side and Terraform-managed; the variable
  reference is [`README.md`](README.md).
