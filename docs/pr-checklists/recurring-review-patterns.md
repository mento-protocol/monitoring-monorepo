---
title: Recurring PR Review Patterns
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: checklist
scope: repo-wide
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Recurring PR Review Patterns

Across the last 20 PRs, review findings clustered into the categories below.
Subsections with a linked checklist treat that checklist as canonical: the
inline tldr is a routing hint, not the source of truth. Subsections without a
link are inline-canonical and are candidates for future extraction.

## Patterns

### Architecture decisions — [checklist](architecture-decisions.md)

tldr: if a PR makes an architectural decision (constrains future work · had a
real alternative · the why isn't obvious from the code), it records an ADR under
`docs/adr/` in the same PR. High-signal triggers — a new package/service, a new
Terraform stack, a new CI/deploy workflow — are flagged by `pnpm adr:check` and
the agent quality gate. A won't-record needs a one-line reason on the PR's
"Architecture decision?" line. Full rules in the linked checklist.

### Prompt exclusions — [checklist](review-prompt-exclusions.md)

tldr: before re-raising a stale or speculative review finding, check the
repo-local exclusion list. Feedback state, optional bot lag, non-canonical plan
files, global skill ownership, docs-only browser verification, advisory gates,
and dashboard scale assumptions all have narrower "do not flag" rules there.
Full rules in the linked checklist.

### SWR + Hasura polling — [checklist](swr-polling-hasura.md)

tldr: every Hasura-polling SWR hook MUST set `revalidateOnFocus:false` + `revalidateOnReconnect:false` (defaulted at `useGQL` in `ui-dashboard/src/lib/graphql.ts`). `useGQL` and `useBridgeGQL` default to a 30s interval; the bridge wrapper owns an 8s timeout, while other fail-fast paths set an explicit timeout below their refresh interval. Respect the 1000-row cap with pre-rolled snapshots or the `fetchPaginatedRows` helper (`ui-dashboard/src/lib/network-fetcher/pagination.ts`). New indexer schema fields ship in an isolated query (`POOL_BREACH_ROLLUP` / `POOL_CONFIG_EXT` pattern) — NEVER mixed into the page's primary pool query (hosted Hasura rejects unknown columns during the deploy+resync window). Distinguish `isLoading` from "data resolved to zero" — NEVER render "100% / no breaches" while `data === undefined`. Full rules in the linked checklist.

### `unstable_cache` usage (server-side SSR/OG caches)

tldr: five hazards, each raised as a separate review round on PR #1210 — audit ALL of them before shipping any new `unstable_cache` site. (1) Values are JSON round-tripped: Map/Set silently become `{}` — use an explicit dehydrate→rehydrate transform. (2) Dynamic renders serve stale entries with NO staleness bound and revalidate in the background — carry `fetchedAt` inside the cached value and age-gate reads. (3) Background-revalidation errors are swallowed (stale keeps serving) — a throw-to-avoid-caching pattern only covers cold misses, and the swallowed `console.error` dumps enumerable error properties (keep large payloads non-enumerable). (4) Vercel's Data Cache persists across deployments — salt key parts with `VERCEL_DEPLOYMENT_ID ?? VERCEL_GIT_COMMIT_SHA ?? "dev"` (covers env-only redeploys; endpoint config in the salt covers local dev). (5) Wrapped-function args are key parts; coalesce concurrent fan-outs at the callback level, or a foreground refetch pairs with Next's own background revalidation and doubles upstream work. Reference implementation + tests: `ui-dashboard/src/lib/network-fetcher/server-cache.ts`; every production `ui-dashboard` cache site now carries the deployment marker plus the resolved endpoint/config identity its response depends on. When the cached payload feeds SWR `fallbackData`, pair any server-side staleness bound with a client mount-revalidation freshness gate (`shouldSkipMountRevalidation` in `ui-dashboard/src/hooks/use-all-networks-data.ts`) so served staleness can't pin on screen until the next poll.

### Time-unit math — [checklist](stateful-data-ui.md)

tldr: FX-pool metrics use trading-seconds — MUST call `tradingSecondsInRange` (`ui-dashboard/src/lib/weekend.ts:110`), NEVER `now - start` directly. Threshold-derived metrics (peak severity %, etc.) MUST be computed from the per-event threshold, NEVER from the live mutable `pool.rebalanceThreshold`. Full rules in the linked checklist.

### Keyboard a11y on controlled widgets — [checklist](keyboard-a11y-controlled-widgets.md)

tldr: roving `tabIndex` follows FOCUS not `selected` (track `focusedIndex` locally, re-sync via render-time ref check — not `useEffect`). `router.replace`-backed tablists use manual activation (arrows = focus only; Enter/Space = activate via native `<button>` onClick). Never gate keyboard activations on `selected`-equality (racy under URL render-lag — bit us 3× on PR #350). `role="tablist"` contains ONLY `role="tab"` children (axe critical) — wrap LimitSelect / dropdowns / search inputs as siblings. Full rules in the linked checklist.

### Indexer entity IDs

- Composite IDs MUST include enough entropy to be collision-resistant under same-block writes. `poolId + startedAt(seconds)` is **insufficient** — include `chainId`, `blockNumber`, and `logIndex` (or `txHash + logIndex`)
- Cumulative counters belong on the entity (rolled up in handlers), not derived client-side from a paginated list

### Multi-chain coverage

- Anywhere indexer code iterates over indexed chains, derive the chain list from `Object.keys(CONTRACT_NAMESPACE_BY_CHAIN)` (in `indexer-envio/src/contractAddresses.ts`), **never** a hardcoded `[42220, 143]`. The same compiled handlers run against `config.multichain.testnet.yaml` (chains 11142220, 10143), so a hardcoded mainnet list silently breaks testnet classification (protocol-owned addresses misclassified, direct-entry routers fall through to "unknown"). This regressed in PR #311 (`isProtocolOwnedAddress` / `classifyAggregator`) and PR #316 (cluster direct entries).

### Config-name → metadata cross-reference tests

- When a config file has a name → metadata lookup pattern (e.g. `aggregators.json`'s `cluster-*` keys ↔ `$clusters` block, or any future `name: "X"` per-chain entry pointing at a separate `$X` metadata block), add a test that asserts every name used in the per-chain entries has a corresponding metadata entry. A typo in either side silently breaks the consumer (e.g. `getClusterMetadata("cluster-7dc08ec28f299c07")` returning `undefined` if you typo the address by one digit). This was caught during PR #316 review.

### Indexer handlers and self-heal — [checklist](indexer-handler-invariants.md)

tldr: RPC caches are bounded; multi-getter effects preserve partial wins and
distinct retry/unsupported sentinels; median-derived values require the full
freshness gate; heal stages widen every downstream predicate/query and retry
partial side effects; direct effects must preload the identical key before a
positive preload return and before entity-dependent early returns, or carry a
bounded-cardinality exemption enforced by the blocking AST invariant; handler
tests mock every reachable RPC path. Entity
IDs, rollups, environment parsing, and Vitest bridge rules live in the linked
checklist.

### Terraform + Cloud Run — [checklist](terraform-cloudrun.md)

tldr: resource-address renames require a `moved` block. To retire a managed
resource without destroying its remote counterpart, use a `removed` block with
an explicit destroy choice as required by [`terraform/AGENTS.md`](../../terraform/AGENTS.md).
Cloud Run `--revision-suffix` must start with a lowercase letter (RFC 1035) and
be unique per run (`$GITHUB_RUN_ID`). Probe path is `/health`, never
`/healthz`. Bootstrap `image` must respond to the configured probe path. WIF
requires `roles/iam.serviceAccountTokenCreator` on the runtime SA the deployer
impersonates. Full Cloud Run rules are in the linked checklist.

### CI workflow gates — [checklist](ci-workflow-gates.md)

tldr: **ruleset-required** workflows (`ci`, `Code Quality`, the Vercel checks) MUST NOT use `paths:`/`paths-ignore:` (skipped runs = pending forever); **advisory** workflows SHOULD use `paths:` to avoid booting a runner on irrelevant PRs (CI-cost control). Deploy jobs MUST gate on `if: github.ref == 'refs/heads/main'`. Third-party actions MUST be SHA-pinned; `node scripts/check-github-action-pins.mjs` enforces this in Code Quality. Concurrency group with `cancel-in-progress: false`. Cache keys MUST include every input that affects the cached output. Full rules in the linked checklist.

### Marker-based setup/cache scripts

- If a setup/cache script uses marker files or input hashes to skip work, the skip condition MUST verify the actual output that downstream commands need, not just the marker. Examples: dependency skips should verify a representative package resolves, Playwright skips should verify the browser executable exists, and codegen skips should verify the generated facade file exists.
- Write marker files only after every validation step represented by that marker has passed. A failed post-install validation must not leave a fresh marker that makes the next run skip the install or rebuild path.

### File-size budget

- Source files MUST stay under **600 lines** (soft cap, advisory). If your change would push a file over 600 lines, split it in the same PR — extract sub-components, helpers, or per-domain modules. Don't append "just one more thing" to a file that's already drifting up.
- Hard cap is **1,000 lines**, enforced by `max-lines` in each package's `eslint.config.mjs` (incl. `indexer-envio` since 2026-05-04). CI blocks merges past this. Per-file escape via `// eslint-disable-next-line max-lines` with a comment explaining why the file genuinely needs to stay big.
- Watchlist/reporting scope MUST be derived from the actual package `eslint.config.*` `max-lines` coverage, not blanket test/spec heuristics. Aegis relaxes complexity rules for `src/**/*.spec.ts` but still enforces `max-lines`, so Aegis specs stay in the watchlist.
- Exemptions (rule disabled): `**/__tests__/**`, `**/*.test.{ts,tsx}`, `**/src/lib/types.ts` (pure type definitions), `indexer-envio/test/Test.ts` (envio-generated harness).
- **Unused-imports gate**: `eslint-plugin-unused-imports` is wired into every package's config with `unused-imports/no-unused-imports: "error"`. Refactor PRs that move blocks between modules can't leave dead imports behind — `--fix` removes them mechanically.
- Files near the line budget are tracked in `docs/notes/file-size-watch.md`; refresh with `node scripts/file-size-watchlist.mjs` before starting a split so growth doesn't slip past unnoticed. External drift jobs should use `--format issue` for GitHub Issues, not `BACKLOG.md`.
- Why this exists: PR #263 split `ui-dashboard/src/app/pool/[poolId]/page.tsx` from 2,831 → 470 lines after a year of unchecked growth. The refactor was a 4-day project; appending one more tab inline was a 30-minute task. Each individual decision was rational; the cumulative drift was not.

### Security / CSP

- CSP is set exclusively by `ui-dashboard/src/middleware.ts`; never add a
  second policy in `next.config.ts`, because browsers intersect duplicate
  headers.
- `buildCspWithNonce` generates a fresh request nonce, injects it into request
  headers for Next's inline scripts, and echoes the policy on the response.
  `script-src` intentionally omits `unsafe-inline` and `unsafe-eval`; custom
  inline scripts need the request nonce or must move to an external file.
- `style-src` retains `unsafe-inline`: nonces do not authorize React's
  attribute-level `style={}` output.
- CSP `connect-src` must include every Hasura and RPC endpoint the dashboard
  calls. `ui-dashboard/src/lib/csp.ts` is authoritative; change
  `csp.test.ts` with the allowlist.
- Auth/allowlist constants must be centralized — don't repeat domain literals across files

### Dashboard server/client module boundaries

- Modules importing `useSWR`, `useNetwork`, `next-auth`, or React-only APIs are
  client-only. Server routes, OG helpers/images, and API handlers must not
  import them directly or transitively.
- Shared constants belong in zero-dependency modules such as
  `ui-dashboard/src/lib/hasura-timeout.ts`. The client GraphQL module keeps a
  compatibility re-export, but new server imports target the zero-dependency
  owner.
- Audit the full import graph when moving a constant. A clean typecheck does
  not prove the Next server bundle is free of SWR/React client dependencies.

### Migration discipline

- Don't remove an env-var fallback in the same PR that introduces the new var. Keep dual-read for one release so mid-deploy state doesn't break

### Dynamic-route metadata + private data — [checklist](dynamic-route-metadata.md)

tldr: `generateMetadata` reading access-controlled data must gate on `isPublic === true` before emitting tags (no session, tags visible to crawlers). `export const revalidate = 0` for access-controlled sources (ISR would serve stale post-revocation tags from the edge cache). Metadata-fetching body lives in a dedicated `_lib/og-metadata.ts` helper imported by the page — not directly in `layout.tsx` — to keep the RSC label-leak guard allowlist narrow (PR #345 commit `b476776`). Full rules in the linked checklist.

### SWR optimistic-update + React-key remount races

- When a child component is React-keyed by a field your optimistic update also writes to (e.g. `key={entry.updatedAt}` while `upsertEntry` bumps `updatedAt` synchronously in `mutate(...)`), you've created a self-remount race against your own writes. Mid-PUT the form unmounts and a fresh mount (with `saving=false`) re-enables the Save button, opening a double-submit window. Reach for the pending-ledger architecture shipped in PR #345 (`address-labels-provider.tsx` + `address-book/[address]/page.tsx`) before re-deriving these through 15 review rounds:
  - **Per-mount instance ID via counter-backed ref** — NOT `useId`. `useId` is tree-position-stable, so a remount at the same key path returns the same id and stale-callback dedup falsely accepts old `(false)` calls.
  - **Separate save / delete owner refs** — a single shared `mutationOwnerRef` breaks under cross-flow timing (Save→Remove fast-click); each flow needs its own owner.
  - **Pending ledger lifted to provider state** — page-mount-scoped state dies on navigation; a user who saves → bounces to the index → re-enters the same address sees a fresh empty ledger and an enabled Save button. Survive page mounts by living in `AddressLabelsProvider`.
  - **Synchronous `inFlightRef` guards** — React's `setSaving(true)` is async; a fast double-click slips past the disabled state. A `useRef({ saving: false, deleting: false })` flipped synchronously inside the handler before any state setter is the only thing that prevents two PUTs from leaving the form for the same Save click.
  - **`<fieldset disabled>` cascade** — disabling Save/Remove without disabling the inputs lets users type into a "would-be-discarded" form; on the optimistic→settled `updatedAt` transition the remount drops their edits. Wrap inputs+buttons in a fieldset.
  - **Content fingerprint always in keys** — not just when `updatedAt` is empty. Imports preserve a non-empty `updatedAt` even when content changed; `JSON.stringify([name, tags, notes, isPublic])` in the key catches that case.

### Sibling-audit rule for multi-component flows

- When fixing a hazard in one component of a flow that has parallel siblings (form ↔ report editor; modal ↔ detail page; index "+ Add" modal ↔ row-edit modal), audit each sibling for the same hazard class before pushing. Cross-flow / cross-mount / cross-surface races usually need symmetric fixes. PR #345 had ~5 review rounds because each fix landed in one surface while the symmetric surface still had the same bug — saving on the form needed a fix, then deletion needed the same fix, then the report editor needed it, then the modal flow needed it, then the add-new modal needed it. Audit once per round; don't ship a half-fix that obviously asks for a re-raise

### Code health budgets — [checklist](code-health.md)

Use the linked checklist for package boundaries, dead code, lint and type
budgets, coverage, duplication, bundle size, schema diff, and advisory
reports. Use the [mutation-testing checklist](mutation-testing.md) for
mutation scope, cadence, and break floors. The agent quality gate owns
changed-path routing and command selection; keep volatile counts, scores, and
workflow details in their canonical owners instead of duplicating them here.
