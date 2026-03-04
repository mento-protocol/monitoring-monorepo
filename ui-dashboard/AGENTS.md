# AGENTS.md — Monitoring Dashboard

## What This Is

Next.js 16 monitoring dashboard for Mento v3 pools. Displays real-time pool data (reserves, swaps, mints, burns) using Plotly.js charts, sourced from Hasura GraphQL.

## Key Files

- `src/app/` — Next.js App Router pages and layouts
- `src/lib/` — Data fetching utilities, GraphQL queries, address book
- `src/lib/addresses.json` — Contract addresses for all networks (committed, not generated)
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

The dashboard supports switching between networks:

- **Celo Devnet** — local/test deployment
- **Celo Sepolia** — public testnet

Network switching is driven by env vars:

- `NEXT_PUBLIC_HASURA_URL_DEVNET` / `NEXT_PUBLIC_HASURA_URL_SEPOLIA`
- `NEXT_PUBLIC_HASURA_SECRET_DEVNET` / `NEXT_PUBLIC_HASURA_SECRET_SEPOLIA`
- `NEXT_PUBLIC_EXPLORER_URL_DEVNET` / `NEXT_PUBLIC_EXPLORER_URL_SEPOLIA`

## Notes

- `addresses.json` is committed directly (no pre-scripts needed)
- The dashboard is purely read-only — no transactions, no wallet connections
- Charts auto-refresh via SWR polling
