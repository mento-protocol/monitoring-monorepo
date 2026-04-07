# AGENTS.md — Monitoring Dashboard

## What This Is

Next.js 16 monitoring dashboard for Mento v3 pools. Displays real-time pool data (reserves, swaps, mints, burns) using Plotly.js charts, sourced from Hasura GraphQL.

## Before Opening PRs

If your dashboard change touches stateful data flow — pagination, sort, search, charts tied to table state, GraphQL shape changes, degraded/error behavior, or any indexer→query→UI field path — read and apply:

- `../docs/pr-checklists/stateful-data-ui.md`

This is mandatory for cross-layer/stateful UI work. The checklist exists because this repo repeatedly burned review cycles on exactly these failure modes.

## Key Files

- `src/app/` — Next.js App Router pages and layouts
- `src/lib/` — Data fetching utilities, GraphQL queries, address book
- `src/lib/networks.ts` — All network definitions; derives token symbols and address labels from `@mento-protocol/contracts` using the active namespace from `shared-config`
- `next.config.ts` — Next.js configuration
- `vercel.json` — Vercel deployment settings
- `eslint.config.mjs` — ESLint flat config
- `postcss.config.mjs` — PostCSS + Tailwind CSS 4

## Commands

```bash
pnpm dev    # Start dev server
pnpm build  # Production build
pnpm start  # Start production server
pnpm lint   # Run ESLint
```

## Tech Stack

- **Next.js 16** (App Router, React Server Components)
- **React 19** + React DOM 19
- **Plotly.js** (via react-plotly.js) for charts
- **SWR** for data fetching + real-time updates
- **graphql-request** for Hasura queries
- **Tailwind CSS 4** for styling

## Multi-Chain Support

The dashboard supports multiple network targets (all defined in `src/lib/networks.ts`):

| ID                     | Chain         | Mode   |
| ---------------------- | ------------- | ------ |
| `devnet`               | Celo devnet   | local  |
| `celo-sepolia-local`   | Celo Sepolia  | local  |
| `celo-sepolia`  | Celo Sepolia  | prod |
| `celo-mainnet-local`   | Celo Mainnet  | local  |
| `celo-mainnet`  | Celo Mainnet  | prod |
| `monad-mainnet` | Monad Mainnet | prod |
| `monad-testnet` | Monad Testnet | prod |

Token symbols and address labels are derived automatically from `@mento-protocol/contracts` using the active treb namespace from `shared-config/deployment-namespaces.json`. Custom address labels (stored in Upstash Redis) merge on top and take precedence. Individual networks can also declare custom `addressLabels` overrides in `makeNetwork(...)`.

Network switching is driven by env vars:

- `NEXT_PUBLIC_HASURA_URL_<NETWORK>`
- `NEXT_PUBLIC_EXPLORER_URL_<NETWORK>`

## Notes

- Contract addresses come from `@mento-protocol/contracts` — no vendored JSON
- The dashboard is purely read-only — no transactions, no wallet connections
- Charts auto-refresh via SWR polling
