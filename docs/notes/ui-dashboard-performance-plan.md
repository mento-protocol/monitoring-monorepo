# UI Dashboard Performance Plan — monitoring.mento.org

> Status: draft execution plan (2026-07-06). Grounded in live production measurement
> (Chrome DevTools trace + resource-timing + HTTP header probes on the deployed site)
> and an adversarially-verified codebase audit. Inspired by Linear's "how is it so
> fast" breakdown, but adapted to a **read-only, frequently-repolled monitoring
> dashboard** — not a local-first mutation app.

---

## 1. TL;DR

The dashboard is **hydration/parse-bound, not network-bound**. The server is fast
(TTFB 24 ms); the slow part is shipping and executing ~6 MB of JavaScript before the
page paints, and that JS is dominated by one chart library.

**Three levers move ~90% of the user-visible win:**

1. **Ship the lean Plotly build.** The original baseline depended on
   `plotly.js-basic-dist-min` but never imported it — `react-plotly.js` pulled the
   **full** `plotly.js` (mapbox-gl + WebGL included) while we only ever draw
   scatter/bar/pie. The shipped factory + peer-alias swap keeps the chart chunk on
   the lean bundle and avoids the unused full Plotly dependency tree.
2. **Fix pool-detail CLS 0.25** (currently "poor") with skeleton height reservation +
   SSR-prefetch of the pool overview — the same pattern that already gives `/` and
   `/pools` a perfect CLS 0.00.
3. **Move the Plotly parse off the first-paint path** (defer to idle on the homepage;
   true scroll-defer for below-the-fold charts elsewhere).

Everything else is either a cheap polish item, an origin-cost/quota efficiency win
(not user-facing speed), or a spike with a high ceiling but real risk.

---

## 2. Measured baseline (production, warm CDN, no throttling)

| Surface                  | LCP                                                 | CLS                | JS (decoded)                                                     | XHR fan-out              |
| ------------------------ | --------------------------------------------------- | ------------------ | ---------------------------------------------------------------- | ------------------------ |
| Homepage `/`             | **1891 ms** (TTFB 24 ms + **render-delay 1867 ms**) | **0.00** ✅        | ~6 MB / 20 chunks; one **4.5 MB** chunk (Plotly, ~1.3 MB brotli) | 39                       |
| Pool detail `/pool/[id]` | content shifts                                      | **0.25** ❌ (poor) | same core + charts                                               | 35 (17 direct-to-Hasura) |

HTTP header probes:

- **Static chunks + fonts:** `public, max-age=31536000, immutable`, `x-vercel-cache: HIT`,
  fonts carry `access-control-allow-origin: *`. **Already optimal** — no work needed.
- **Dynamic HTML (`/`, `/pools`, `/pool/*`):** `cache-control: private, no-cache,
no-store`, `x-vercel-cache: MISS`, `age: 0`. The `export const revalidate = 60` is a
  **no-op** — the root layout's `getAuthSession()` cookie read forces every request to
  render dynamically. Real, but secondary (TTFB is already 24 ms).

RUM is already flowing: `src/instrumentation-client.ts` runs the Sentry browser SDK at a
20% prod sample; its default `browserTracingIntegration` collects LCP/CLS/INP. **We can
measure before/after in Sentry's Web Vitals view** — no new RUM tooling required.

---

## 3. Diagnosis — what is actually slow, and why

- **LCP is render-delay, not TTFB.** 1867 of 1891 ms is spent downloading/parsing/
  executing/hydrating JS. The fix space is _bundle weight_ and _when_ heavy JS runs —
  not the server, not the CDN, not the database.
- **Plotly is the whole story on weight.** One 4.5 MB-decoded chunk. We ship the full
  build by accident (see §5.1), and it hydrates eagerly as the first content block on
  the homepage and across chart-heavy pages.
- **Pool detail's CLS 0.25 is a client-waterfall artifact.** Unlike `/` and `/pools`,
  `/pool/[id]` fetches everything post-hydration and swaps a tiny `Skeleton rows={2}`
  (~88 px) for a tall `PoolHeader + HealthPanel + PoolChartsRow` block — a layout jump.
- **Fan-out (17–39 XHR) is not the bottleneck.** They multiplex over one HTTP/2
  connection; reducing count mainly relieves Envio small-tier quota, not latency.

---

## 4. Already optimal / explicit non-goals

Ruled out by measurement or documented repo decisions — **do not propose these**:

| Non-goal                                                          | Why                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add caching headers to static assets                              | Already `immutable` + CDN `HIT`.                                                                                                                                             |
| Variable-font / font-CORS work (Linear #11)                       | Geist woff2 self-hosted, `display:swap`, correct CORS — done.                                                                                                                |
| Service-worker precache (Linear #6)                               | Can't touch the JS-parse bottleneck; adds a stale-shell failure mode on a repolled dashboard. Documented non-goal.                                                           |
| Modern-browser-only target (Linear #4)                            | Conflicts with the documented ES2017 support contract (Safari ≤15 / Chrome ≤109); SWC keys on browserslist, not tsconfig — minimal reclaimable weight anyway.                |
| Broad `"use client"` → RSC migration                              | Components pulled into the client graph by client parents ship as client regardless; data pages are legitimately client (30 s-polled client aggregation). Zero byte savings. |
| Hasura `_aggregate` queries                                       | Decision (d): use snapshot entities / client pagination.                                                                                                                     |
| List virtualization                                               | 30–50 pools; decision (e) says client aggregation is fine.                                                                                                                   |
| Local-first sync engine / optimistic mutations (Linear #1/#2/#10) | This is a read-only monitoring dashboard; the adaptable core (warm-start cache) is captured as a spike in §5, Tier 4.                                                        |

---

## 5. The plan (prioritized workstreams)

Effort: **S** <½d · **M** ~1–2d · **L** ~3–5d · **XL** >1wk. Impact is scored against the
**measured** metrics (LCP render-delay, CLS, bundle KB), with efficiency/polish called
out explicitly.

### Tier 0 — Measurement & guardrails (do alongside Tier 1; makes wins durable)

- **G1 · Per-logical-chunk size tracking** (S, tooling). Extend `.size-limit.cjs`
  (already exports `_private.collectManifestReferencedStaticAssets`) to emit budgets
  for the _content-matched_ Plotly and markdown chunks. **Do not key on filename** —
  Turbopack content-hashes every build; match on asset text (`plotly` / `react-markdown`).
  This regression-proofs §5.1 and §5.4.
- **G2 · Confirm Sentry Web Vitals + establish before/after.** Verify LCP/CLS/INP are
  visible in Sentry's Web Vitals view (they are, via `instrumentation-client.ts`).
  Snapshot the current pool-detail CLS and homepage LCP as the baseline to beat. Drop
  the unused direct `web-vitals ^5.2.0` dependency (`package.json:78`, imported nowhere
  — Sentry bundles its own). knip-tier cleanup.

### Tier 1 — High-leverage (the meat)

- **P1 · Swap full `plotly.js` → `plotly.js-basic-dist-min`.** ⭐ _Anchor win._
  Confidence **high**, effort **M**, impact **high** (~**−0.45 MB brotli**, directly on
  the LCP-window chunk).
  - Original baseline: every chart used `dynamic(() => import("react-plotly.js"))`,
    whose default entry imported the full `plotly.js` (pulls `mapbox-gl@1.13.3` +
    WebGL). Trace audit:
    only `scatter`/`bar`/`pie` are used anywhere — no gl/3d/mapbox/heatmap traces —
    so basic-dist-min covers **100%** of usage. The declared dep is imported nowhere
    (`package.json:36`; only referenced in a `globals.css` comment).
  - Change: build one shared `Plot` via `react-plotly.js/factory` +
    `plotly.js-basic-dist-min`; keep the `plotly.js` peer aliased to
    `plotly.js-basic-dist-min` so pnpm does not install the unused full package.
    `react-plotly.js` v4 ships the factory types; only the basic dist needs a
    local `declare module` shim. Route all chart sites through the shared wrapper.
  - Verify: `pnpm dashboard:build && pnpm dashboard:size-limit`; confirm the drop and
    re-baseline the budget. Browser-verify every chart type still renders.

- **P2 · Kill pool-detail CLS 0.25** (two parts, ship together). Impact **high**.
  - **P2a · Reserve skeleton dimensions** (M). `PoolOverview` returns `Skeleton rows={2}`
    (~88 px) then expands to `PoolHeader + HealthPanel + PoolChartsRow`
    (`pool-detail-page-client.tsx:378`); `loading.tsx` omits the header/metric-grid/charts
    entirely. Give the skeleton the resolved block's height (chart cards are already
    CLS-stable via `ROW_CHART_HEIGHT_PX=200`). Realistic target **CLS ≤ 0.1** ("good");
    <0.05 needs per-pool-type height tuning (FPMM vs virtual pools differ). Mirror the
    fix in `loading.tsx`.
  - **P2b · SSR-prefetch the pool overview** (M–L). Apply the proven
    SSR-payload → SWR `fallbackData` pattern (from `/` and `/pools`, now served
    through `fetchInitialNetworkData` in `network-fetcher/server-cache.ts`) to
    `/pool/[id]`. The server _already_ round-trips the endpoint every request for OG
    metadata (`fetchPoolForMetadata`, `unstable_cache({revalidate:60})`), so the
    infra template exists — but the OG payload is transformed, so add a raw-shape
    server fetch for the overview query and hand it to the client as `fallbackData`.
    **Critical:** the SWR key is `[network.id, query, {id: normalizePoolIdForChain(...),
chainId}]` — the server must reproduce the exact normalized id + `network.id`
    (`networkIdForChainId`) or the fallback silently misses and CLS stays 0.25.
    Extends decision (b); preserves (c) 30 s client polling and (d) no-aggregate.

- **P3 · Move the Plotly parse off first paint.** Effort **M**, impact **medium**
  (needs-measurement — magnitude depends on the actual LCP element).
  - Homepage charts are _hero_ content (first block after the `<h1>`), so an
    IntersectionObserver fires immediately — it does **not** scroll-defer there. Use
    **`requestIdleCallback`-gated mount** to push the 4.5 MB parse past first paint on
    the homepage.
  - For genuinely below-the-fold charts (pool-detail stacked charts, `/volume`,
    `/stables`, `/revenue`, `/bridge-flows`), add **IntersectionObserver-gated mount**
    (true scroll-defer). Build one `useDeferredMount(mode)` primitive; none exists today.
  - **Guardrail:** the deferred skeleton→chart swap must reserve the _exact_ chart
    height (the dynamic-import loading fallback currently defaults to 200 px, not the
    card's `heightPx`) or it regresses the homepage's CLS 0.00. Measure LCP delta before
    committing; stacks cleanly on P1.

### Tier 2 — Solid, cheaper wins

- **P4 · Code-split the markdown editor** (S, medium). `react-markdown` + `remark-gfm` +
  `rehype-sanitize` (full unified/micromark pipeline) ship _statically_ in the shared
  chunk of 5+ client-waterfall pages via `AddressLink` (imported by 16 modules), yet only
  mount behind `{editing && …}` (`address-link.tsx:112`). Wrap `AddressLabelEditor` in
  `dynamic(ssr:false)` at the point of use — the click gesture masks the fetch, so it's
  perceptually free. ~50–70 KB brotli (confirm via G1) off `/pool`, `/volume`, `/cdps`,
  `/stables`, `/bridge-flows`.
- **P5 · Prefetch pool data on hover/focus** (S, medium — perceived instant nav). SWR
  ships `preload`; no preload exists in `src`. On pools-table row hover
  (`global-pools-table/pool-row.tsx:138`), warm the pool-detail SWR key. Export the
  currently module-private `getClient`/fetcher (`graphql.ts:19`). Same `network.id` key
  parity caveat as P2b. Fires only on intent → no first-load cost; 30 s poll takes over
  post-mount (respects (c)).
- **P6 · `loading.tsx` for `/volume`** (S, low–medium). `/volume/page.tsx` is `async` and
  `await getAuthSession()` **before** the Suspense boundary, so client nav blocks the whole
  segment on session decode with no instant fallback. Add a route-level skeleton. Other
  passthrough routes render their client component synchronously, so their win is marginal
  — `/volume` is the real one.

### Tier 3 — Efficiency / cost / polish (low user-facing speed, but cheap or strategic)

- **P7 · Cache `fetchAllNetworks` server-side** (L, medium — _origin CPU + Envio quota_,
  not LCP). **Shipped** (2026-07-09): `src/lib/network-fetcher/server-cache.ts` wraps the
  fan-out in `unstable_cache` (30s TTL) with an explicit dehydrate→rehydrate transform
  for the Map/Set fields, caches healthy payloads only (degraded ones pass through
  uncached via an error carrier — cold misses only, since `unstable_cache` serves stale
  entries and swallows background-revalidation errors; a `fetchedAt` age gate bounds
  served staleness at 5 minutes with a foreground refetch, covering the stale-serve path
  so `N/A` tiles are never pinned), and strips the unread raw `feeSnapshots` rows from
  the `/` + `/pools` Flight payload. **Payload projection shipped 2026-07-15:** the
  transport now carries the 30 UTC-day default v3 window plus one latest pre-window
  anchor per pool for TVL forward-fill, and the exact 30 UTC-day Broker window. It omits
  the redundant 1/7/30-day arrays. `useAllNetworksData` reconstructs those
  arrays synchronously from the bounded canonical rows before consumers or
  incremental-cache seeding; selecting a chart's "All" range triggers the normal
  full-history SWR fetch, and capped seeds remain cache-incomplete until that pagination
  succeeds. The cumulative LP-address arrays are replaced by the homepage's exact
  cross-chain union count, while `/pools` receives neither Broker history nor LP data
  because it consumes neither. This is the audited transport invariant: every
  time/cumulative `InitialNetworkData` field is bounded, omitted, or aggregated; the
  remaining collections are bounded by current configured entities. Note the
  impact re-rating vs. this plan's original scoring: a 2026-07-09 re-measure showed the
  homepage document _streaming_ until 0.9–1.9s (the fan-out runs inside the streamed
  RSC content, not TTFB), so this was in fact the homepage LCP lever, not just cost.
  Original analysis for context: `NetworkData` carries `Set` (olsPoolIds…) and
  `Map` (oracle `rates`, `poolLabels`) fields; `unstable_cache` JSON-serializes and
  **silently drops** them (`JSON.stringify(new Map())==='{}'`) → lost strategy badges +
  oracle rates. Requires a serialize→plain→rehydrate transform, or Next 16 `"use cache"`
  (Flight serializer preserves Map/Set; needs the `cacheComponents` flag). Re-verify the
  degraded/partial-data invariant through the cache (stateful-data-ui checklist).
- **P8 · Scope middleware `auth()` to protected paths** (M, low — _edge CPU/Vercel cost_).
  `middleware.ts:80` wraps every matched request in `auth((req)=>…)`, running a jose JWT
  decrypt on 100% of traffic incl. public pages. NextAuth v5 can invoke the handler only
  for protected paths. Won't enable static caching (the per-response nonce forces dynamic
  regardless) and won't move CWV (TTFB already 24 ms) — purely an efficiency win. Must
  rewrite `middleware.test.ts` (coupled to the `export default auth(cb)` shape) and keep
  `csp.test.ts` green. Preserves the nonce-CSP posture — no decision conflict.
- **P9 · `preconnect` + `dns-prefetch` to `indexer.hyperindex.xyz`** (S, low). No resource
  hints exist (`layout.tsx:56`). HTTP/2 multiplexes, so this warms exactly one handshake
  (~1 RTT, once) — cheap, modest. Use a hoisted `<link>` / `ReactDOM.preconnect`
  (`crossOrigin=anonymous` for the CORS POST socket).
- **P10 · Memoize `AddressLabelsProvider` context value** (S, low). Returns a plain object
  literal (`address-labels-provider.tsx:~439`) unlike the correctly-memoized
  `NetworkProvider:58`. Real defect, but SWR's default deep-equal means it does **not**
  re-render every 30 s poll (no custom compare) — it bites only on actual label changes /
  pending-mutation ledger updates, authenticated-only, INP-scoped. Cheap sibling-matching
  fix; don't oversell it.
- **P11 · `viewport = { colorScheme: 'dark' }`** (S, low). No `color-scheme` anywhere;
  native surfaces (scrollbar, form controls, overscroll) paint light before CSS. The
  `viewport` export lands `<meta name=color-scheme>` in the initial `<head>` (pre-CSS).
  globals.css already sets the body background, so this is native-UI polish, not a
  white-flash fix.
- **P12 · `experimental.optimizePackageImports: ['@web3icons/react']`** (S, low,
  measurement-gated). `chain-icon.tsx:2` barrel-imports; the lib isn't in Next's default
  list. Safe no-op if the lib already ships per-icon ESM. Confirm the delta with G1 before
  claiming a win.
- **P13 · `transition-all` → `transform`/`opacity` + tighten durations** (S, low, _last_).
  Six meter/progress-bar sites use `transition-all` on width/height (Linear #13) and one
  `duration-500` (`reserves-panel.tsx:255`) is outside the snappy 100–250 ms band
  (Linear #14). Bars update only on the 30 s poll with no reflow, so runtime impact is
  negligible — batched style-compliance cleanup + a `transition-all` hover footgun.

### Tier 4 — Spikes (high ceiling, real uncertainty — investigate before committing)

- **S1 · Persisted SWR cache (localStorage/IndexedDB warm-start)** (L, medium ceiling —
  the adaptation of Linear's local-first #1/#8). Would give returning users last-known
  data **instantly** on cold reload, then revalidate. `swr-provider.tsx:39` sets no cache
  provider (default in-memory Map dies on reload). **Two hazards make this a spike, not a
  task:** (1) SWR reads the persisted cache _before_ SSR `fallbackData`, so a seeded value
  on the `/` and `/pools` keys would render stale on first paint and risk a hydration
  mismatch on exactly the pages fixed for CLS 0.4896 — must exclude SSR-prefetched keys;
  (2) monitoring data must not show dangerously stale numbers (TTL-drop + forced
  revalidate + a visible "updating" indicator). Prototype behind a flag; measure
  warm-reload paint vs. mismatch risk.
- **S2 · GraphQL transport batching** (L, low — _quota_, not latency). Spike whether the
  hosted Envio Hasura endpoint accepts `graphql-request` array-batched POSTs and returns
  per-operation errors at HTTP 200 (load-bearing for the deliberately-split schema-lag
  resilience). Not a `_aggregate` (no (d) conflict). Only worth it for quota pressure.
- **S3 · React Compiler `compilationMode: "all"`** (M, low — INP only). Today only 1 of
  172 files carries `"use memo"`. Auto-compiling all doesn't reduce the 6 MB parse and
  slightly _increases_ bundle KB — it only trims INP, and there's no measured INP problem.
  Build-time only, so `react-doctor` 100/100 is safe, but needs full browser
  re-verification of 172 components. Low priority.
- **S4 · Extend SSR-prefetch to remaining client-waterfall pages** (L, medium). Roadmap
  follow-on to P2b: `/bridge-flows` (already server-fetches for OG), `/volume`, `/cdps`,
  `/revenue`, `/stables`. Each needs a raw-shape server fetch (OG payloads are
  transformed, not reusable) + the P2b key-parity technique + the loading-vs-zero
  degraded-mode rule. Sequence highest-traffic first, after P2 proves the pattern.

---

## 6. Prioritization matrix

| #   | Item                             | Impact (on measured metric) | Effort | Conf  | Moves             |
| --- | -------------------------------- | --------------------------- | ------ | ----- | ----------------- |
| P1  | Plotly full → basic-dist-min     | **High** (−0.45 MB brotli)  | M      | High  | Bundle, LCP       |
| P2a | Pool-detail skeleton height      | **High**                    | M      | High  | CLS 0.25→≤0.1     |
| P2b | SSR-prefetch pool overview       | **High**                    | M–L    | High  | CLS, perceived    |
| P3  | Defer/gate Plotly parse          | Med (measure)               | M      | Med   | LCP render-delay  |
| P4  | Code-split markdown editor       | Med                         | S      | High  | Bundle (5+ pages) |
| P5  | Hover-prefetch pool data         | Med (perceived)             | S      | High  | Nav feel          |
| P6  | `loading.tsx` for `/volume`      | Low–Med                     | S      | High  | Nav feel          |
| P7  | Cache `fetchAllNetworks`         | Med (origin/quota)          | L      | Med   | Cost, not LCP     |
| P8  | Middleware auth scoping          | Low (cost)                  | M      | Med   | Edge CPU          |
| P9  | preconnect to indexer            | Low                         | S      | High  | ~1 RTT            |
| P10 | AddressLabels memo               | Low (INP)                   | S      | High  | Correctness       |
| P11 | `color-scheme: dark`             | Low                         | S      | High  | Native UI         |
| P12 | optimizePackageImports web3icons | Low (measure)               | S      | Low   | Bundle            |
| P13 | `transition-all` cleanup         | Low                         | S      | High  | Style compliance  |
| S1  | Persisted SWR warm-start         | Med ceiling / High risk     | L      | Spike | Cold reload       |
| S2  | GraphQL batching                 | Low (quota)                 | L      | Spike | Requests          |
| S3  | React Compiler "all"             | Low (INP)                   | M      | Spike | INP               |
| S4  | SSR-prefetch other pages         | Med                         | L      | Med   | CLS/perceived     |

---

## 7. Suggested sequencing (maps to PRs / issues)

- **Batch A — "Cut the weight" (biggest win, low risk):** G1 + P1 + P4 + P12.
  One coherent bundle-reduction PR set; re-baseline size-limit. Verify every chart +
  the markdown editor in-browser. _Expected: ~0.5 MB brotli off the critical path._
- **Batch B — "Stabilize pool detail":** P2a + P2b (+ P6). The CLS 0.25 fix. Ship the
  skeleton-reservation and SSR-prefetch together so CLS lands in "good".
- **Batch C — "Snappier paint + nav":** P3 + P5 + P9 + P11. Perceived-speed pass;
  gate P3 on an LCP measurement.
- **Batch D — "Efficiency/cost":** P7 + P8 + P10 + P13. Origin-cost + polish; no user
  metric expected to move, so verify via Vercel usage / Sentry, not CWV.
- **Spikes (parallel, timeboxed):** S1 first (highest ceiling), then S4; S2/S3 only if
  quota/INP data justifies.

Each item is issue-shaped (per the repo's issue-driven backlog). Recommend filing
Batches A–B as `agent-ready` issues with the acceptance criteria = the measured target
(size-limit delta / CLS threshold), so verification is objective.

---

## 8. How we verify (objective gates)

- **Bundle:** `pnpm dashboard:build && pnpm dashboard:size-limit`; G1 gives per-chunk
  visibility so a regression can't hide in the aggregate.
- **CWV:** Sentry Web Vitals (LCP/CLS/INP @ 20% prod sample) — compare the pool-detail
  CLS and homepage LCP distributions before/after each batch. Supplement with a local
  Chrome DevTools trace for a deterministic lab number.
- **No-regression guardrails:** homepage must stay CLS 0.00 (P3's skeleton-height rule);
  `react-doctor` 100/100 and the size-limit budget stay green; browser-verify all chart
  types render after P1.

---

## 9. Appendix — Linear technique → our applicability

| Linear technique                             | Verdict for this dashboard                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1 Local-first IndexedDB                      | Adapt as **warm-start persisted cache** (spike S1); full sync engine is overkill for read-only polling. |
| 2 Optimistic mutations                       | N/A (read-only; only address-book mutates).                                                             |
| 3 Granular observables (per-field re-render) | Partial via React Compiler (S3) — but no measured INP problem, so low priority.                         |
| 4 Aggressive code splitting / modern-only    | **Yes on splitting** (P1/P4); modern-only target is a non-goal (support contract).                      |
| 5 modulepreload                              | Next/Turbopack emits chunk preloads already; add origin preconnect (P9).                                |
| 6 Service-worker precache                    | **Non-goal** (won't touch parse cost; stale-shell risk).                                                |
| 7 Inlined critical CSS                       | Next injects render-blocking `globals.css`; no separate action.                                         |
| 8 Inline boot script (theme/auth)            | Partial: `color-scheme` meta (P11); warm-start cache (S1).                                              |
| 9 Render-first-authenticate-second           | Middleware auth scoping (P8) is the local flavor.                                                       |
| 10 Delta sync over WebSocket                 | N/A (30 s polling is deliberate — decision (c)).                                                        |
| 11 Variable font + CORS                      | **Already done** (Geist woff2, `display:swap`, correct CORS).                                           |
| 12 Keyboard-first                            | UX scope, out of band for this perf plan.                                                               |
| 13 GPU-only animations                       | P13 (low signal).                                                                                       |
| 14 Short asymmetric durations                | P13 (one 500 ms outlier).                                                                               |
| 15 Vendor bundle independence                | Turbopack content-hashed chunks already immutable-cached (CDN HIT).                                     |
