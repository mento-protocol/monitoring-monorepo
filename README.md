# Mento Monitoring Monorepo

Real-time monitoring infrastructure for Mento v3 on-chain pools — a multichain [Envio HyperIndex](https://docs.envio.dev/) indexer paired with a Next.js 16 + Plotly.js dashboard.

<!-- agent-context: title="Mento Monitoring Monorepo" status=active owner=eng canonical=true last_verified=2026-07-22 doc_type=reference scope=repo-wide review_interval_days=90 garden_lane=package-readmes-reference -->

**Live dashboard:** [monitoring.mento.org](https://monitoring.mento.org)

## Packages

| Package                                         | Description                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`indexer-envio`](./indexer-envio/)             | Envio HyperIndex indexer — Celo + Monad + Polygon multichain                                                |
| [`ui-dashboard`](./ui-dashboard/)               | Next.js 16 + Plotly.js multi-chain dashboard — all chains shown together, network derived from the pool URL |
| [`metrics-bridge`](./metrics-bridge/)           | Hasura state + isolated CEX/RPC peg observations → Prometheus exporter                                      |
| [`shared-config`](./shared-config/)             | Public `@mento-protocol/config` package for protocol metadata, thresholds, and shared ABIs                  |
| [`aegis`](./aegis/)                             | App Engine v2 alerting service + Aegis Grafana dashboards                                                   |
| [`governance-watchdog`](./governance-watchdog/) | Cloud Function watching Mento Governance events → Discord/Telegram (own GCP project)                        |

## Architecture

```text
 Celo / Monad / Polygon / Ethereum events (HyperSync / RPC)
                     │
                     ▼
          Envio HyperIndex (hosted, mento)
                     │
                     ▼
                Hasura GraphQL API ─────────► Next.js dashboard (Vercel)
                     │
                     └──────────────────────┐
 CEX order books ──────────────────────────┤
 RPC oracle conversion views ──────────────┴──► metrics-bridge (Cloud Run)
                                                   │
                                                   ▼
                                          Grafana Alloy / Cloud
```

`config.multichain.mainnet.yaml` configures a single Envio project (`mento`) for Celo Mainnet (42220), Monad Mainnet (143), Polygon Mainnet (137), and Ethereum reserve-yield events (1). Polygon becomes live at the static endpoint after the normal indexer deploy, sync verification, and promotion workflow. Pool IDs are namespaced as `{chainId}-{address}` to prevent cross-chain collisions. Ethereum reserve-yield indexing is event-only; the historical sUSDS onBlock heartbeat is not registered in the hosted indexer.

`metrics-bridge` retains its indexed Hasura poller and owns an isolated peg
lifecycle. When the protected policy artifact is configured, that loop combines
indexed pool and trading-limit state with direct CEX order books and RPC oracle
conversion views before exporting bounded Prometheus gauges.

**Static production endpoint:** `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`

## Networks

| Network       | Chain ID | Status                                                                |
| ------------- | -------- | --------------------------------------------------------------------- |
| Celo Mainnet  | 42220    | Live in the production multichain indexer                             |
| Monad Mainnet | 143      | Live in the production multichain indexer                             |
| Polygon       | 137      | Configured in the production multichain indexer                       |
| Ethereum      | 1        | Live in the production multichain indexer — reserve-yield events only |
| Celo Sepolia  | 11142220 | Hosted dashboard support is opt-in via testnet env vars               |
| Monad Testnet | 10143    | Hosted dashboard support is opt-in via testnet env vars               |
| Polygon Amoy  | 80002    | Hosted dashboard support is opt-in via testnet env vars               |

The canonical Polygon contract, dashboard, alert-condition, deferral, and
production-cutover matrix is
[`docs/notes/polygon-monitoring.md`](./docs/notes/polygon-monitoring.md).

## Getting Started

### Prerequisites

- Node.js 24 LTS
- [pnpm](https://pnpm.io/) 11.x
- Docker (for local indexer dev — runs Postgres + Hasura)

### Install

For a fresh clone or manually-created worktree, prefer the setup script so
workspace deps, postinstall hooks, Playwright Chromium, and Envio codegen are
handled in one place:

```bash
./scripts/setup.sh
```

When creating worktrees through Worktrunk (`wt switch --create` / `wt switch
-c`), the committed `.config/wt.toml` runs this setup script automatically as a
blocking `pre-start` hook before any launch command configured with `-x`
starts.

For a Codex Cloud environment, configure the environment setup script to run:

```bash
./scripts/codex-cloud-setup.sh
```

Also configure the optional maintenance script for cached container resumes:

```bash
./scripts/codex-cloud-maintenance.sh
```

That path performs the frozen install, Envio codegen, and agent-context check
inside the cloud container, while relying only on repo-visible files by default.
Codex Cloud does not inherit a developer's local `~/.agents` directory, so the
repo vendors the required autoreview helper at `scripts/agent-autoreview.mjs`.
Set `AUTOREVIEW_HELPER` only when intentionally replacing that helper with a
compatible implementation of its CLI contract. Prepared-bundle replacements
receive only the final prompt handoff and must support `--bundle-output`,
`--bundle-output-display`, and `--trusted-input-root`; the wrapper-attested
helper owns source fingerprinting and untracked-file serialization from a
private manifest-bound runtime created before that handoff. In the owning
checkout that runtime must come from compatible pinned protected-main blobs;
runtime-changing reviews must use a separate trusted wrapper checkout
physically outside the reviewed checkout. Its default sibling helper is still
privately attested when named explicitly through `AUTOREVIEW_HELPER`. The setup
and maintenance scripts fail fast when the effective helper is missing because
PR shipping requires `pnpm agent:autoreview`.
Semantic review uses the complete branch-local target and an isolated empty
reviewer workspace. Oversized direct semantic runs fail closed; prepared
bundles preserve bounded lossless passes for one fresh-context reviewer to
inspect together. Run
`pnpm agent:autoreview --verify-bundle-dir <dir>` immediately before that
reviewer reads every pass, retain its printed manifest digest outside the
bundle, then rerun with `--expected-bundle-manifest <retained-digest>` after
review; the completion marker binds the verified evidence manifest. Capture
enforces a cumulative byte budget before diffs, untracked files, and
supplemental evidence accumulate. Sensitive review input fails closed,
including wallet recovery phrases; reviewer web search is off by default unless
`--web-search` is explicit. Prepared bundles pin one protected `origin/main`
snapshot for checklist policy, the owning-checkout default semantic helper, and
automatic-feedback modules, never a PR-selected base, mutable worktree, or
branch-controlled package scripts. Wrapper-owned Node launches discard
`NODE_OPTIONS`, `NODE_PATH`, and loader/startup injection variables. Direct
executables require trusted ownership and
non-shared-writable ancestry. On Darwin, Homebrew-style paths are accepted only
through sealed private native Mach-O snapshots with system-only library
closure. On Linux, a root-run wrapper may recover an otherwise path-untrusted
Node (including root- or foreign-owned writable/hard-linked toolcache layouts)
only when it is the exact live ancestor of the canonical wrapper across an
uninterrupted all-root UID chain; direct helper invocation remains fail-closed.
The wrapper seals the exact ELF inode and its validated glibc startup closure;
the helper revalidates the snapshot, sealed manifest, loader, and alias handoff
around semantic-engine launches.
Scripts and unsafe library closure fail closed. Prepared-bundle
creation and verification also reject macOS write-granting ACLs on parent
ancestors or bundle entries.
Runtime-changing PRs use a clean, compatible wrapper/helper from the last
independently reviewed pre-change commit; the exact external-runtime review
sequence is documented in `docs/notes/agent-quality-gate-mechanics.md`.
Autoreview remains source review, so the quality gate and applicable browser or
runtime verification are still required.

The maintenance path runs after Codex checks out the task branch in a cached
container; it refreshes `origin/main`, verifies the autoreview helper, syncs
branch lockfile changes with `pnpm install --frozen-lockfile --prefer-offline`,
reruns Envio codegen, and validates the agent context.

If you install manually, verify the dashboard can resolve its Sentry package
after `pnpm install`:

```bash
pnpm install
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"
```

> **Supply-chain gate:** `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`
> (3 days), so pnpm refuses to resolve registry versions younger than 3
> days. Frozen-lockfile installs (CI, `./scripts/setup.sh`) are unaffected.
> If you hit `ERR_PNPM_PACKAGE_TOO_YOUNG` — during `pnpm add`, a
> lockfile-updating `pnpm install`, or `pnpm update` — pin to a slightly
> older version or wait out the gate. For urgent CVE patches that need a
> brand-new release immediately, override per-invocation by appending
> `--config.minimumReleaseAge=0` to the failing command (e.g.
> `pnpm add --config.minimumReleaseAge=0 <pkg>` or
> `pnpm update --config.minimumReleaseAge=0 <pkg>`). `@mento-protocol/*`
> is exempted so our own releases install same-day.

### Run the Indexer (local)

```bash
# Multichain mainnet (Celo + Monad + Polygon) — default
pnpm indexer:codegen && pnpm indexer:dev

# Multichain testnet (Celo Sepolia + Monad Testnet + Polygon Amoy)
pnpm indexer:testnet:codegen && pnpm indexer:testnet:dev
```

### Run the Dashboard

```bash
pnpm dashboard:codegen
pnpm dashboard:dev
```

The dashboard dev script defaults to the live production Envio GraphQL endpoint
when `NEXT_PUBLIC_HASURA_URL` is unset, so fresh git worktrees use live
production data without copying `.env.local`. Set `NEXT_PUBLIC_HASURA_URL` explicitly
only when you need a non-prod endpoint.

For deterministic browser review, run the dashboard package directly on a fixed
port and verify both auth states when the UI differs for signed-in users:

```bash
cd ui-dashboard
AUTH_SECRET=local-dev-dashboard-auth-secret-do-not-use-in-prod \
AUTH_GOOGLE_ID=local-dev-google-id \
AUTH_GOOGLE_SECRET=local-dev-google-secret \
pnpm dev --hostname 127.0.0.1 --port 3210
```

Open <http://127.0.0.1:3210>. Use no Auth.js session cookie for logged-out
checks. To simulate a signed-in `@mentolabs.xyz` user locally, mint an
`authjs.session-token` with `next-auth/jwt` using the same `AUTH_SECRET`; the
exact agent workflow lives in
[`docs/notes/dashboard-verification.md`](./docs/notes/dashboard-verification.md).

### Run Aegis

```bash
pnpm aegis:dev
pnpm aegis:typecheck
pnpm aegis:test
```

Aegis remains the NestJS App Engine service in `mento-monitoring`; the monorepo
operator interface is the root `pnpm aegis:*` command family.

### Dashboard Browser Tests

```bash
pnpm --filter @mento-protocol/ui-dashboard test:browser
```

The browser suite starts the Next.js app with a local GraphQL fixture server so
it can exercise routing, focus, hydration, and degraded query states without
hitting hosted Hasura/Envio. The agent quality gate installs Playwright
Chromium before running it; for direct fresh-checkout runs, install it once with
`pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium`.

### Targeted Mutation Baseline

```bash
pnpm indexer:mutation
pnpm dashboard:mutation
pnpm bridge:mutation
```

These run the non-required StrykerJS baselines for targeted indexer, dashboard,
and metrics-bridge pure logic. See
[`docs/mutation-testing.md`](./docs/mutation-testing.md) for scope, runtime,
score, and survivor classification.

For unused-code discovery across all packages (report-only, doesn't exit non-zero), run:

```bash
pnpm code-health:knip:report
```

For a strict run that fails on unused files / unlisted deps (the same gate CI runs):

```bash
pnpm code-health:knip
```

## Environment Variables

### Indexer

Create `indexer-envio/.env` from `indexer-envio/.env.example`:

| Variable                                   | Description                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ENVIO_RPC_URL_42220`                      | Celo Mainnet primary RPC endpoint                                                                              |
| `ENVIO_RPC_URL_143`                        | Monad Mainnet primary RPC endpoint                                                                             |
| `ENVIO_RPC_URL_137`                        | Polygon Mainnet primary RPC endpoint                                                                           |
| `ENVIO_RPC_URL_80002`                      | Polygon Amoy primary RPC endpoint                                                                              |
| `ENVIO_RPC_FALLBACK_URL_<chainId>`         | (optional) per-chain fallback RPC for archive-depth + rate-limit failover (see `indexer-envio/README.md`)      |
| `ENVIO_START_BLOCK_CELO`                   | Celo start block (default: 60664500)                                                                           |
| `ENVIO_START_BLOCK_MONAD`                  | Monad start block (default: 60710000)                                                                          |
| `ENVIO_START_BLOCK_POLYGON`                | Polygon start block (default: 90273661)                                                                        |
| `ENVIO_START_BLOCK_POLYGON_AMOY`           | Polygon Amoy start block (default: 37555761)                                                                   |
| `ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD` | Ethereum reserve-yield start block (default: 19111760)                                                         |
| `INDEXER_PERF`                             | Optional indexer sync profiler; set to `1` to log handler/effect/entity counters during local or debug replays |
| `INDEXER_PERF_LOG_INTERVAL_EVENTS`         | Optional profiler log interval in processed handler calls (default: 10000)                                     |

### Dashboard

| Variable                                   | Description                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `ENABLE_EXPERIMENTAL_COREPACK`             | Vercel Corepack opt-in so hosted builds honor the repo `packageManager` pnpm version (Terraform-managed)   |
| `NEXT_PUBLIC_HASURA_URL`                   | Prod Envio GraphQL endpoint (shared by Celo, Monad, Polygon, and Ethereum reserve-yield data)              |
| `NEXT_PUBLIC_HASURA_URL_TESTNET`           | Optional shared Monad Testnet + Polygon Amoy Envio GraphQL endpoint                                        |
| `NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA`      | Optional Celo Sepolia Envio GraphQL endpoint                                                               |
| `NEXT_PUBLIC_RPC_URL_POLYGON_MAINNET`      | Optional Polygon RPC override (default: `https://polygon.drpc.org`)                                        |
| `NEXT_PUBLIC_RPC_URL_POLYGON_AMOY`         | Optional Polygon Amoy RPC override (default: `https://polygon-amoy.drpc.org`)                              |
| `NEXT_PUBLIC_EXPLORER_URL_POLYGON_MAINNET` | Optional Polygon explorer-base override (default: `https://polygonscan.com`)                               |
| `NEXT_PUBLIC_EXPLORER_URL_POLYGON_AMOY`    | Optional Polygon Amoy explorer-base override (default: `https://amoy.polygonscan.com`)                     |
| `NEXT_PUBLIC_SHOW_TESTNET_NETWORKS`        | Set to `true` with the per-testnet endpoint URL to show hosted testnet networks                            |
| `NEXT_PUBLIC_SWR_CACHE_BUILD_SALT`         | Auto-set from Vercel deployment/commit; invalidates the bounded client cache (`dev` locally)               |
| `HASURA_SECRET_CELO_SEPOLIA_LOCAL`         | Optional server-only admin secret for `/api/hasura/celo-sepolia-local` proxy                               |
| `HASURA_SECRET_CELO_MAINNET_LOCAL`         | Optional server-only admin secret for `/api/hasura/celo-mainnet-local` proxy                               |
| `HASURA_UPSTREAM_URL_CELO_SEPOLIA_LOCAL`   | Optional upstream URL override for local sepolia Hasura proxy (default `http://localhost:8080/v1/graphql`) |
| `HASURA_UPSTREAM_URL_CELO_MAINNET_LOCAL`   | Optional upstream URL override for local mainnet Hasura proxy (default `http://localhost:8080/v1/graphql`) |
| `UPSTASH_REDIS_REST_URL`                   | Address labels storage (Upstash Redis)                                                                     |
| `UPSTASH_REDIS_REST_TOKEN`                 | Address labels Redis auth token                                                                            |
| `AUTH_SECRET`                              | Auth.js JWT secret; required for local simulated login and real OAuth sessions                             |
| `AUTH_GOOGLE_ID`                           | Google OAuth client id; non-empty placeholder is enough for local simulated login                          |
| `AUTH_GOOGLE_SECRET`                       | Google OAuth client secret; non-empty placeholder is enough for local simulated login                      |
| `BLOB_STORE_ID`                            | Vercel Blob OIDC store id for daily label backups (set by the Vercel store integration)                    |
| `BLOB_WEBHOOK_PUBLIC_KEY`                  | Vercel Blob OIDC public key (set by the Vercel store integration)                                          |

### Integration Probes

| Variable                        | Description                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `INTEGRATION_PROBES_HASURA_URL` | Optional override for the pool-discovery GraphQL endpoint                                   |
| `LIFI_API_KEY`                  | LI.FI/Jumper quote API key; probes return `needs_key` without it                            |
| `FLYTRADE_API_KEY`              | Optional Fly.trade (Magpie) API key for authenticated Fly follow-up requests                |
| `OPENOCEAN_API_KEY`             | Optional OpenOcean Pro quote API key                                                        |
| `ZEROX_API_KEY`                 | Optional 0x quote API key                                                                   |
| `ONEINCH_API_KEY`               | Optional 1inch quote API key                                                                |
| `SQUID_INTEGRATOR_ID`           | Squid integrator id; probes return `needs_key` without it                                   |
| `SQUID_CELO_RPC_URL`            | Optional Celo RPC override for Squid Uniswap-liquidity discovery sizing (defaults to Forno) |
| `SOCKET_API_KEY`                | Optional Socket quote API key                                                               |

Production env vars are managed by Terraform except the Blob OIDC variables, which are managed by the Vercel store integration. See [`terraform/`](./terraform/).

## Deployment

### Indexer → Envio Hosted

Push to the `envio` branch to trigger a hosted reindex:

```bash
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
pnpm deploy:indexer:status "$COMMIT" --watch --compact
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
pnpm deploy:indexer:perf "$COMMIT"
pnpm deploy:indexer:verify "$COMMIT"
pnpm deploy:indexer:promote "$COMMIT"
```

The status watcher only proves a deployment caught up. Promotion additionally
requires `deploy:indexer:verify` to pass core-row and Polygon replay semantics;
`--allow-syncing` never waives those data-integrity checks.

For an agent-operated production rollout, use the repo's `/deploy-indexer`
skill: it also captures the prior production commit, confirms promotion, waits
for endpoint propagation, and verifies the dashboard in the browser. After a
pre-merge `/deploy-indexer --no-promote`, finish a tree-matching candidate with
an explicitly authorized `/deploy-indexer --resume-preload <commit>`; do not
use the bare promote command as a shortcut.

If a promotion turns out bad, roll back with
`pnpm deploy:indexer:rollback <last-good-sha>` - see
[docs/deployment.md](./docs/deployment.md#rollback-a-bad-promotion).

The `mento` project on [Envio Cloud](https://envio.dev/app/mento-protocol/mento)
watches this branch. Envio registers deployments under short commit hashes and
can lag the Git push by several minutes, so use the explicit commit form while
babysitting a new deploy.

### Aegis → App Engine

```bash
pnpm aegis:build
pnpm aegis:typecheck
pnpm aegis:deploy   # builds, stages a locked App Engine app, then deploys to mento-monitoring
pnpm aegis:logs
```

Grafana Alloy deploys from the same project under the existing `grafana-agent`
service/command names. Deploy only when its three Secret Manager values already
have enabled versions and the effective App Engine runtime identity has been
verified:

```bash
pnpm aegis:agent:deploy
```

The legacy seed command writes secret versions with `gcloud` and is not an
agent-authorized bootstrap or rotation path under ADR 0030. Follow
[`aegis/grafana-agent/README.md`](./aegis/grafana-agent/README.md); issue
[#1473](https://github.com/mento-protocol/monitoring-monorepo/issues/1473)
tracks its policy-compliant replacement.

The Aegis dashboard lives in `aegis/terraform` and keeps the existing GCS
backend prefix `aegis`; the Aegis service-health alert rules moved to
`alerts/rules/rules-aegis-service.tf` (issue #706):

```bash
pnpm aegis:tf:init
pnpm aegis:tf:plan
# Apply runs in CI on merge to main (.github/workflows/aegis-terraform.yml),
# gated by the `production-infra` GitHub Environment required-reviewer rule.
```

Protocol Grafana alert rules and global Grafana routing live in
`alerts/rules`; event-driven Slack/Sentry/QuickNode delivery lives in
`alerts/infra`, including the Splunk On-Call rotation announcer.
`terraform.stacks.json` and [docs/terraform.md](./docs/terraform.md)
are the stack registry and operator overview. Never run Terraform apply without
reviewing the plan first.

### Dashboard → Vercel

Every push to `main` that touches `ui-dashboard/` auto-deploys to [monitoring.mento.org](https://monitoring.mento.org).

Infrastructure (Vercel project, env vars, Upstash Redis, GCP project shape, CI
WIF/IAM, Metrics Bridge Cloud Run shape, and Aegis bootstrap resources) is
managed by the `platform` Terraform stack:

```bash
pnpm tf list        # show all registered Terraform stacks
pnpm infra:plan     # preview platform changes
pnpm infra:apply    # apply platform changes after review
```

Aggregator integration snapshots are produced by the scheduled
`Integration Probes` GitHub Actions workflow and rendered at
`/integrations`. Chain statuses are `pass` only for full active USDm hub-pair
coverage and `partial` when some pair directions pass but others still lack
Mento v3 address evidence. Aggregator rows also include a 30d public volume
signal when a stable source such as DefiLlama exposes one; the signal is context,
not a health gate. Run the same quote-only check manually with:

```bash
pnpm integrations:probe
pnpm integrations:probe --write-upstash
pnpm integrations:probe --adapter openocean,relay --chain 42220 --pair-limit 1 --output .tmp/integration-probe-smoke.json
```

## Contract Addresses

Sourced from the published [`@mento-protocol/contracts`](https://www.npmjs.com/package/@mento-protocol/contracts) npm package. The active treb deployment namespace per chain is declared in [`shared-config/deployment-namespaces.json`](./shared-config/deployment-namespaces.json).

## Key Files

| What                         | Where                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Indexer schema               | `indexer-envio/schema.graphql`                                                   |
| Event handlers               | `indexer-envio/src/EventHandlers.ts`                                             |
| Pool ID helpers              | `indexer-envio/src/helpers.ts`                                                   |
| Multichain config            | `indexer-envio/config.multichain.mainnet.yaml`                                   |
| Indexer deployment reference | `indexer-envio/STATUS.md`                                                        |
| Dashboard app                | `ui-dashboard/src/app/`                                                          |
| Network defs                 | `ui-dashboard/src/lib/networks.ts`                                               |
| GraphQL queries              | `ui-dashboard/src/lib/queries.ts` (barrel) + `ui-dashboard/src/lib/queries/*.ts` |
| Dashboard GraphQL types      | `ui-dashboard/src/lib/__generated__/graphql.ts`                                  |
| Terraform infrastructure     | `terraform/`                                                                     |

## Documentation

- [`docs/README.md`](./docs/README.md) — Generated catalog of every unique documentation surface, grouped by gardening lane and authority
- [`docs/context-standards.md`](./docs/context-standards.md) — Canonical versus historical context and metadata rules
- [`docs/adr/README.md`](./docs/adr/README.md) — Architecture decision index and lifecycle
- [`docs/deployment.md`](./docs/deployment.md) — Deployment guide

## License

[GNU General Public License v3.0 only](./LICENSE)
