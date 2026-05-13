# Browser Component/Interaction Testing Pilot

## Scope Decision

Playwright Component Testing was the first option checked for this pilot, but it
does not fit the dashboard's highest-risk browser behavior well enough right now. The
flows worth proving depend on the Next.js App Router, URL-backed state,
`next/navigation`, SWR cache keys, the CSP header, and GraphQL request behavior.
Mounting isolated React components under Playwright CT would require Vite-time
shims for those app-level dependencies and would still miss the routing and
hydration behavior that jsdom cannot prove.

The pilot therefore uses a minimal app-level Playwright harness:

- Next.js runs normally in dev mode.
- `NEXT_PUBLIC_HASURA_URL` points at a local fixture server.
- The fixture server returns deterministic GraphQL JSON and never talks to
  hosted Hasura or Envio.
- Tests use the real browser for focus, keyboard activation, URL changes, CSP,
  hydration, Plotly rendering, and SWR request/error behavior.

## Covered Flows

- Cross-chain pool navigation from `/pools` to a Monad pool detail page, proving
  the route-derived network context switches in the browser.
- Pool detail tab keyboard behavior, proving roving focus does not activate tabs
  until Enter and that activation writes the expected URL state.
- Degraded GraphQL behavior, proving a failed swaps query surfaces a visible
  error while the rest of the pools page remains usable.

## Setup Friction

- The real app harness is simpler than Playwright CT for this codebase because
  it avoids shimming Next router modules and dashboard providers.
- A local GraphQL fixture server is required because server-rendered metadata
  and browser-side SWR calls both need the same deterministic data source.
- CSP needed a test-only connect-src extension for the fixture origin, gated by
  `NEXT_PUBLIC_BROWSER_TEST_FIXTURES=true`.
- Local quality-gate runs and CI install Playwright's bundled Chromium before
  running the tests.

## Runtime

- Local bundled Chromium, Next dev plus fixture
  server startup: `pnpm --filter @mento-protocol/ui-dashboard test:browser`
  completed 3 tests in 9.6s on 2026-05-12.
- Acceptance target: stable headless run that would add less than two minutes
  as a required PR check.
