<!-- agent-context: title="Integration Probes" status=active owner=eng canonical=true last_verified=2026-08-20 doc_type=reference scope=integration-probes review_interval_days=90 garden_lane=package-readmes-reference -->

# Integration Probes

`@mento-protocol/integration-probes` runs quote-only checks against DEX
aggregators and cross-chain routers and publishes the latest snapshot to Upstash
Redis for the dashboard `/integrations` page. The default mainnet fleet is Celo
(42220), Monad (143), and Polygon (137).

Probe policy, evidence rules, and adapter tiering live in
[`AGENTS.md`](AGENTS.md); commands are listed there and in
[`../docs/notes/quick-commands.md`](../docs/notes/quick-commands.md).

## Environment variables

- `INTEGRATION_PROBES_HASURA_URL` overrides `NEXT_PUBLIC_HASURA_URL` for the
  pool discovery query.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required only when
  writing snapshots.
- Adapter credentials are optional at the infrastructure layer and surface as
  `needs_key` when missing: `LIFI_API_KEY`, `OPENOCEAN_API_KEY`, `ZEROX_API_KEY`,
  `ONEINCH_API_KEY`, `SQUID_INTEGRATOR_ID`, and `SOCKET_API_KEY`.
- `LIFI_API_KEY` authenticates LI.FI/Jumper quote probes with `x-lifi-api-key`.
- `FLYTRADE_API_KEY` authenticates the Fly.trade follow-up requests behind Monad
  LI.FI routes with the `apikey` header against the authenticated
  `api.magpiefi.xyz` origin; without it the probe falls back to the public
  `api.fly.trade` origin. It is optional and not part of `credentialEnv`, so a
  missing key never renders LI.FI as `needs_key`.
- `SQUID_INTEGRATOR_ID` authenticates Squid quote probes with `x-integrator-id`.
- `SQUID_CELO_RPC_URL` optionally overrides the default Forno Celo RPC used for
  Squid Uniswap-liquidity discovery sizing. It is not a credential.

Keep every credential server-side and Terraform-managed.
