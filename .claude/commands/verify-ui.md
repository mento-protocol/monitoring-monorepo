# Verify UI

Verify the current UI state in the browser using chrome-devtools MCP.

Default to the canonical fixed local server at <http://127.0.0.1:3210> using
`docs/notes/dashboard-verification.md`. Use another local port only when you
have already confirmed that the same documented server command is running
there, and report the exception. When the user asks to verify against
production, use <https://monitoring.mento.org>.

## Pages to cover by default

When the user asks for a broad verify (no specific page), hit these in order and report per-page. Routes mirror the nav links in `src/components/nav-links.tsx`.

1. **Homepage** `/` — KPI tiles + protocol-wide TVL/volume chart + attention pools
2. **Pools** `/pools` — full pools table with health indicators
3. **Pool detail** `/pool/{id}` — pick any active pool from `/pools`. Verify TVL/volume charts, oracle freshness, rebalance history, swap table
4. **Volume** `/volume` — global volume, flow insights, and chain filter
5. **Stables** `/stables` — supply/custody across configured chains
6. **Bridge Flows** `/bridge-flows` — Wormhole NTT transfers
7. **CDPs** `/cdps` — CDP overview and current position health
8. **Integrations** `/integrations` — auth-gated adapter coverage by chain
9. **Revenue** `/revenue` — auth-gated KPI tiles + historical chart
10. **Address book** `/address-book` — auth-gated; verify logged-in when possible, otherwise verify the logged-out redirect/sign-in state
11. **Entities** `/entities` — auth-gated entity and address relationships

For a narrow verify (specific page or feature), skip the list and go directly to the requested URL.

## Steps

1. **Check MCP availability.** If chrome-devtools tools aren't loaded, say so and stop — don't guess or fake results.

2. **Navigate** to the relevant page. If the user specified a URL or route, use that. Otherwise follow the "Pages to cover" list above.

3. **Choose auth state deliberately.** Do not rely on whatever cookies happen
   to be in the browser. For public/logged-out checks, use an isolated browser
   context or clear `authjs.session-token` and `__Secure-authjs.session-token`.
   For logged-in localhost checks, follow
   `docs/notes/dashboard-verification.md` to mint a local
   `authjs.session-token` for `dev@mentolabs.xyz` using the same `AUTH_SECRET`
   as the dev server. Session-dependent surfaces should be checked in both
   states.

4. **Verify content and errors.** Confirm the page heading and key text render,
   data values are non-empty and plausible (not "$0.00" or "..." everywhere),
   and no empty state such as "No pools found" appears where data is expected.
   Then check `list_console_messages(types: ["error"])` for 500s, unhandled
   exceptions, and React errors.

5. **Exercise changed behavior.** When the change alters interactive behavior
   (sort, click, tab, filter, form) or layout, drive that interaction with
   `click`/`evaluate_script` and confirm the resulting state; for layout work,
   re-check the affected routes at the relevant breakpoints with `resize_page`.
   A content-and-console pass alone does not cover interaction changes.

6. **Report** a concise pass/fail summary. If something failed, include what you expected vs what you saw.

7. **Verify dynamic social previews when applicable.** When a change touches
   dynamic route metadata or an Open Graph image route, run the "Dynamic
   social-preview verification" section in
   `docs/notes/dashboard-verification.md` against the final deployed origin.
   Run this check after the production deployment for post-merge closeout. A
   localhost or preview result does not prove the production social preview.

## Auth-state checks

- Logged out: nav shows `Sign in`; authenticated-only nav links are hidden;
  protected routes redirect to `/sign-in?callbackUrl=...`.
- Logged in: nav shows `dev@mentolabs.xyz` and `Sign out`; `/address-book`,
  `/entities`, and `/integrations` render; edit affordances and authenticated
  controls are visible.
- `/volume`: logged-out users see total volume only; logged-in users can see
  the Organic/All control. Verify whichever of those states the change affects.

## Route-specific assertions

`docs/notes/dashboard-verification.md` owns the per-route assertions for
Polygon coverage and `/bridge-flows` (KPI row, charts, per-cell explorer
targets, filter/sort interactions, STUCK overlay). Apply them whenever the
change touches those surfaces.
