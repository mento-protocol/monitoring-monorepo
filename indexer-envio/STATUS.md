# HyperIndexer Handoff (Celo)

## Current state

- Repo: `devnet`
- Branch: `feat/envio-celo-indexer`
- Latest indexer commits:
  - `0c351694` - `feat: add hardened Celo HyperIndexer scaffold`
  - `d278b26e` - `docs: expand HyperIndexer runbook and add flow diagram`
- Local working tree still has unrelated, uncommitted changes:
  - `bin/start-explorer.sh`
  - `tools/address-book/server.mjs`
  - `.trunk/` (untracked)
  - `indexers/celo/.cursor/` (untracked)

## What is implemented

- Envio indexer package in `indexers/celo`
- Address-book-driven sync:
  - reads addresses/RPC from `tools/address-book/addresses.json`
  - copies ABIs from `../mento-core/out/**`
  - writes `indexers/celo/config.yaml` and `indexers/celo/config/contracts.celo.v3.json`
- Hardened command wrapper:
  - `indexers/celo/scripts/run-envio-with-env.mjs`
  - loads `.env`
  - validates `ENVIO_START_BLOCK` + `ENVIO_RPC_URL`
  - forces `CI=true` only for `codegen` (non-TTY safe)
- Start block chosen and verified:
  - `ENVIO_START_BLOCK=60548751`
- Schema + handlers for:
  - `FactoryDeployment`
  - `Pool`
  - `SwapEvent`
  - `LiquidityEvent`
  - `ReserveUpdate`
  - `RebalanceEvent`
  - `VirtualPoolLifecycle`

## Runbook (known good)

From repo root:

```bash
pnpm indexer:celo:prepare
pnpm indexer:celo:dev
```

Stop/reset local services/state:

```bash
pnpm --dir indexers/celo stop
```

## Environment defaults

See `indexers/celo/.env.example`:

- `ENVIO_RPC_URL="http://34.32.123.41:8545"`
- `ENVIO_START_BLOCK="60548751"`

## Query endpoint

- Hasura: `http://localhost:8080`
- GraphQL: `http://localhost:8080/v1/graphql`
- Admin secret: `testing`

## Verified query output (historical reference)

Earliest rows observed after reset/restart:

- `FactoryDeployment.blockNumber = 60550751`
- `Pool.createdAtBlock = 60550751` (FPMM), `60550752` (virtual pool)
- `SwapEvent` starts at `60550758`

## Known gotchas

- If indexing appears to start from old history, persisted state may exist: run `pnpm --dir indexers/celo stop`.
- `pnpm codegen` must run with env loaded; wrapper script now enforces this.
- `indexers/celo` includes generated/runtime artifacts by design for reproducibility.

## Next objective (UI)

Build a local UI for indexed data (swaps/pools) with:

1. Basic recent swaps table (sorted by block desc)
2. Pool filter (by pool address)
3. URL-as-state for filters (shareable links)
4. Keyboard-accessible controls and semantic table markup

## UI implementation breakdown

### MVP (ship first)

1. Scaffold a minimal UI app in `indexers/celo/ui` (TypeScript).
2. Add a small GraphQL client helper for `http://localhost:8080/v1/graphql`.
3. Implement `RecentSwapsTable`:
   - query latest `SwapEvent` rows
   - default sort: `blockNumber DESC`, then `logIndex DESC`
   - show loading, empty, and error states
4. Implement pool filter UI:
   - text input for pool address
   - apply/clear buttons
   - keyboard operable controls
5. Persist filter state in URL query params:
   - `?pool=<address>&limit=<n>`
   - read on load, write on change
6. Add basic validation for pool address input (hex + length).

### Stretch goals (after MVP)

1. Add pagination controls (cursor or offset-based).
2. Add relative timestamps and block links.
3. Add client-side CSV export for current filtered rows.
4. Add a pool summary card (last trade, volume proxy, last reserve update block).

### Acceptance checks

1. With no filters, table shows newest swaps.
2. With `?pool=<known_pool>`, only that pool's swaps render.
3. Clearing filter updates URL and restores unfiltered list.
4. Entire workflow is keyboard-only usable.
5. Invalid pool address shows validation feedback and does not query.

### First-session command sequence

Run indexer stack first:

```bash
pnpm indexer:celo:prepare
pnpm indexer:celo:dev
```

Then start UI app from the new `indexers/celo/ui` package and verify:

1. UI loads with recent swaps.
2. URL query state round-trips via refresh.
3. Pool filter returns expected subset.

## Suggested fresh-session prompt

```markdown
Continue from `indexers/celo/STATUS.md`.

Goal: build a lightweight local UI for Envio-indexed data (SwapEvent + Pool) against Hasura GraphQL.

Constraints:

- keep existing indexer pipeline unchanged
- prioritize accessibility and URL-as-state
- start with read-only UI and clear loading/error states
```
