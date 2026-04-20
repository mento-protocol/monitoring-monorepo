# Verify UI

Verify the current UI state in the browser using chrome-devtools MCP.

Default to the dev server at <http://localhost:3000> (or 3001 if 3000 is in use). When the user asks to verify against production, use <https://monitoring.mento.org>.

## Pages to cover by default

When the user asks for a broad verify (no specific page), hit these in order and report per-page:

1. **Homepage** `/` — pool table + KPI tiles + oracle/volume charts
2. **Pool detail** `/pool/{id}` — pick any active pool from `/`. Verify charts, rebalance history, swap table
3. **Revenue** `/revenue` — KPI tiles + historical chart
4. **Bridge Flows** `/bridge-flows` — Wormhole NTT transfers (see below)
5. **Oracle** `/oracle` — oracle rate snapshots + chart

For a narrow verify (specific page or feature), skip the list and go directly to the requested URL.

## Steps

1. **Check MCP availability.** If chrome-devtools tools aren't loaded, say so and stop — don't guess or fake results.

2. **Navigate** to the relevant page. If the user specified a URL or route, use that. Otherwise follow the "Pages to cover" list above.

3. **Verify content** using `evaluate_script` for targeted checks (~50 tokens each):
   - Page heading and key text rendered correctly
   - Data values are non-empty and plausible (not "$0.00" or "..." everywhere)
   - No "No pools found" or similar empty-state messages when data is expected

4. **Check for errors** with `list_console_messages(types: ["error"])`. Report any 500s, unhandled exceptions, or React errors.

5. **Take a snapshot** only if something looks wrong or you need to investigate further. Prefer `take_snapshot(filePath)` to save tokens, then grep the file for what you need.

6. **If testing interactions** (sort, click, tab switch), use `click(uid, includeSnapshot=true)` for action + verification in a single call.

7. **If testing responsive layout**, use `resize_page` + `evaluate_script` to check column visibility at each breakpoint (desktop 1440, tablet 768, mobile 375).

8. **Report** a concise pass/fail summary. If something failed, include what you expected vs what you saw.

## Page-specific checks

### `/bridge-flows`

- **KPI row (3 tiles):** `Total Bridge Transfers` (BreakdownTile w/ 24h/7d/30d breakdown), `Pending` (number or "1,000+"), `Avg deliver time` (h/m/s). None should be "—" or "…" on a healthy load.
- **Charts row (3 columns):** `Bridged Volume (USD)` time-series chart with 7d/30d/all range buttons, `Token Breakdown` donut, `Top Bridgers` ranked list with address links.
- **Recent transfers table (25 rows):** columns Provider, Route, Status, Token, Amount (USD), Amount, Sender, Receiver, Txs, Time. Each row should have a Wormholescan link via the token/amount/`wh` pill click targets.
- **Key interactions to spot-check:**
  - Click a sortable header (e.g. "Amount (USD)") → rows re-sort, arrow flips on second click
  - Click an `AddressLink` → opens explorer for the correct chain (Celoscan for 42220 senders, MonadExplorer for 143)
  - Click the Wormholescan `wh` pill → opens `wormholescan.io/#/tx/{sentTxHash}?network=Mainnet` (NOT the digest)
- **STUCK overlay:** if any row is `SENT`/`ATTESTED`/`QUEUED_INBOUND` and older than 24h, the status badge should read "Stuck" in red.
- **Empty / error states:** an error from one query should NOT blank the whole page — each KPI/chart/table gates on its own backing query.

## Token budget guidelines

- Routine check (page loads, data renders): ~100-200 tokens via evaluate_script
- Interaction check (click, sort, navigate): ~1800 tokens via click+snapshot
- Full page audit (all content + console + Lighthouse): ~2000-3000 tokens
