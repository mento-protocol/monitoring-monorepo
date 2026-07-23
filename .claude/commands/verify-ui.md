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
6. **Bridge Flows** `/bridge-flows` — Wormhole NTT transfers (see below)
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

4. **Verify content** using `evaluate_script` for targeted checks (~50 tokens each):
   - Page heading and key text rendered correctly
   - Data values are non-empty and plausible (not "$0.00" or "..." everywhere)
   - No "No pools found" or similar empty-state messages when data is expected

5. **Check for errors** with `list_console_messages(types: ["error"])`. Report any 500s, unhandled exceptions, or React errors.

6. **Take a snapshot** only if something looks wrong or you need to investigate further. Prefer `take_snapshot(filePath)` to save tokens, then grep the file for what you need.

7. **If testing interactions** (sort, click, tab switch), use `click(uid, includeSnapshot=true)` for action + verification in a single call.

8. **If testing responsive layout**, use `resize_page` + `evaluate_script` to check column visibility at each breakpoint (desktop 1440, tablet 768, mobile 375).

9. **Report** a concise pass/fail summary. If something failed, include what you expected vs what you saw.

## Auth-state checks

- Logged out: nav shows `Sign in`; authenticated-only nav links are hidden;
  protected routes redirect to `/sign-in?callbackUrl=...`.
- Logged in: nav shows `dev@mentolabs.xyz` and `Sign out`; `/address-book`,
  `/entities`, and `/integrations` render; edit affordances and authenticated
  controls are visible.
- `/volume`: logged-out users see total volume only; logged-in users can see
  the Organic/All control. Verify whichever of those states the change affects.

## Page-specific checks

### Polygon coverage

- `/pools` and `/volume`: select Polygon, verify the URL contains `chain=137`, only Polygon rows/series remain, refresh preserves the selection, and selecting All removes the default query parameter without an RSC refetch.
- Polygon pool detail: EURm/EUROP renders every active strategy (Open and Reserve once the promoted schema/data are available); during schema rollout, the page degrades to the legacy pointer without blanking the rest of the pool.
- `/stables`: Polygon USDm and EURm appear as distinct chain-qualified burning-mode supplies rather than being merged with another chain's token row.
- `/integrations`: Polygon appears for every configured adapter and empty/error states remain distinct from unsupported coverage.

### `/bridge-flows`

- **KPI row (3 tiles):** `Total Bridge Transfers` (BreakdownTile w/ 24h/7d/30d breakdown), `Pending` (number or "1,000+"), `Avg deliver time` (h/m/s). None should be "—" or "…" on a healthy load.
- **Charts row (3 columns):** `Bridged Volume (USD)` time-series chart with 7d/30d/all range buttons, `Token Breakdown` donut, `Top Bridgers` ranked list with address links.
- **Recent transfers table (25 rows):** columns Provider, Route, Status, Token, Amount (USD), Amount, Sender, Receiver, Txs, Time. Per-cell click targets:
  - **Wormholescan** (`wormholescan.io/#/tx/{sentTxHash}`): Provider badge, Amount (USD), Amount, and the `wh` pill in the Txs column
  - **Chain explorer** (Celoscan / Monadscan / Polygonscan): Token cell (`token contract`), Sender, Receiver, and the `src` pill in the Txs column
- **Key interactions to spot-check:**
  - Set source or destination to Polygon → URL contains `source=137` or `destination=137`, the opposite filter/status survives, and pagination resets to page 1
  - Refresh/back/forward preserves source, destination, status, and page; malformed/default parameters canonicalize out of the URL
  - Click a sortable header (e.g. "Amount (USD)") → rows re-sort, arrow flips on second click
  - Click an `AddressLink` → opens the correct explorer (Celoscan for 42220, MonadExplorer for 143, Polygonscan for 137)
  - Click the Wormholescan `wh` pill → opens `wormholescan.io/#/tx/{sentTxHash}?network=Mainnet` (NOT the digest)
- **STUCK overlay:** the status badge should read "Stuck" in red once a row remains `SENT` for more than 1h, `ATTESTED` for more than 15m, or `QUEUED_INBOUND` for more than 24h.
- **Empty / error states:** an error from one query should NOT blank the whole page — each KPI/chart/table gates on its own backing query.

## Token budget guidelines

- Routine check (page loads, data renders): ~100-200 tokens via evaluate_script
- Interaction check (click, sort, navigate): ~1800 tokens via click+snapshot
- Full page audit (all content + console + Lighthouse): ~2000-3000 tokens
