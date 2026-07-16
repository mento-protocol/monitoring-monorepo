---
title: Recurring PR Review Patterns
status: active
owner: eng
canonical: true
last_verified: 2026-07-16
---

# Recurring PR Review Patterns

Across the last 20 PRs, review findings clustered into the categories below. **Subsections with a linked checklist (`— docs/pr-checklists/X.md`)** treat the checklist as canonical — the inline tldr is a routing hint, not the source of truth. Subsections without a link are inline-canonical (no upstream checklist yet — candidates for future extraction).

## Patterns

### Architecture decisions — `docs/pr-checklists/architecture-decisions.md`

tldr: if a PR makes an architectural decision (constrains future work · had a
real alternative · the why isn't obvious from the code), it records an ADR under
`docs/adr/` in the same PR. High-signal triggers — a new package/service, a new
Terraform stack, a new CI/deploy workflow — are flagged by `pnpm adr:check` and
the agent quality gate. A won't-record needs a one-line reason on the PR's
"Architecture decision?" line. Full rules in the linked checklist.

### Prompt exclusions — `docs/pr-checklists/review-prompt-exclusions.md`

tldr: before re-raising a stale or speculative review finding, check the
repo-local exclusion list. Feedback state, optional bot lag, non-canonical plan
files, global skill ownership, docs-only browser verification, advisory gates,
and dashboard scale assumptions all have narrower "do not flag" rules there.
Full rules in the linked checklist.

### SWR + Hasura polling — `docs/pr-checklists/swr-polling-hasura.md`

tldr: every Hasura-polling SWR hook MUST set `revalidateOnFocus:false` + `revalidateOnReconnect:false` (defaulted at `useGQL` in `ui-dashboard/src/lib/graphql.ts`) and `AbortSignal.timeout(8_000)` paired with the 10s interval. Respect the 1000-row cap with pre-rolled snapshots or the `fetchAllFeeSnapshotPages` offset-pagination helper (`ui-dashboard/src/lib/network-fetcher/fetch.ts:333`). New indexer schema fields ship in an isolated query (`POOL_BREACH_ROLLUP` / `POOL_CONFIG_EXT` pattern) — NEVER mixed into the page's primary pool query (hosted Hasura rejects unknown columns during the deploy+resync window). Distinguish `isLoading` from "data resolved to zero" — NEVER render "100% / no breaches" while `data === undefined`. Full rules in the linked checklist.

### `unstable_cache` usage (server-side SSR/OG caches)

tldr: five hazards, each raised as a separate review round on PR #1210 — audit ALL of them before shipping any new `unstable_cache` site. (1) Values are JSON round-tripped: Map/Set silently become `{}` — use an explicit dehydrate→rehydrate transform. (2) Dynamic renders serve stale entries with NO staleness bound and revalidate in the background — carry `fetchedAt` inside the cached value and age-gate reads. (3) Background-revalidation errors are swallowed (stale keeps serving) — a throw-to-avoid-caching pattern only covers cold misses, and the swallowed `console.error` dumps enumerable error properties (keep large payloads non-enumerable). (4) Vercel's Data Cache persists across deployments — salt key parts with `VERCEL_DEPLOYMENT_ID ?? VERCEL_GIT_COMMIT_SHA ?? "dev"` (covers env-only redeploys; endpoint config in the salt covers local dev). (5) Wrapped-function args are key parts; coalesce concurrent fan-outs at the callback level, or a foreground refetch pairs with Next's own background revalidation and doubles upstream work. Reference implementation + tests: `ui-dashboard/src/lib/network-fetcher/server-cache.ts`; every production `ui-dashboard` cache site now carries the deployment marker plus the resolved endpoint/config identity its response depends on. When the cached payload feeds SWR `fallbackData`, pair any server-side staleness bound with a client mount-revalidation freshness gate (`shouldSkipMountRevalidation` in `ui-dashboard/src/hooks/use-all-networks-data.ts`) so served staleness can't pin on screen until the next poll.

### Time-unit math — `docs/pr-checklists/stateful-data-ui.md`

tldr: FX-pool metrics use trading-seconds — MUST call `tradingSecondsInRange` (`ui-dashboard/src/lib/weekend.ts:110`), NEVER `now - start` directly. Threshold-derived metrics (peak severity %, etc.) MUST be computed from the per-event threshold, NEVER from the live mutable `pool.rebalanceThreshold`. Full rules in the linked checklist.

### Keyboard a11y on controlled widgets — `docs/pr-checklists/keyboard-a11y-controlled-widgets.md`

tldr: roving `tabIndex` follows FOCUS not `selected` (track `focusedIndex` locally, re-sync via render-time ref check — not `useEffect`). `router.replace`-backed tablists use manual activation (arrows = focus only; Enter/Space = activate via native `<button>` onClick). Never gate keyboard activations on `selected`-equality (racy under URL render-lag — bit us 3× on PR #350). `role="tablist"` contains ONLY `role="tab"` children (axe critical) — wrap LimitSelect / dropdowns / search inputs as siblings. Full rules in the linked checklist.

### Indexer entity IDs

- Composite IDs MUST include enough entropy to be collision-resistant under same-block writes. `poolId + startedAt(seconds)` is **insufficient** — include `chainId`, `blockNumber`, and `logIndex` (or `txHash + logIndex`)
- Cumulative counters belong on the entity (rolled up in handlers), not derived client-side from a paginated list

### Multi-chain coverage

- Anywhere indexer code iterates over indexed chains, derive the chain list from `Object.keys(CONTRACT_NAMESPACE_BY_CHAIN)` (in `indexer-envio/src/contractAddresses.ts`), **never** a hardcoded `[42220, 143]`. The same compiled handlers run against `config.multichain.testnet.yaml` (chains 11142220, 10143), so a hardcoded mainnet list silently breaks testnet classification (protocol-owned addresses misclassified, direct-entry routers fall through to "unknown"). This regressed in PR #311 (`isProtocolOwnedAddress` / `classifyAggregator`) and PR #316 (cluster direct entries).

### Config-name → metadata cross-reference tests

- When a config file has a name → metadata lookup pattern (e.g. `aggregators.json`'s `cluster-*` keys ↔ `$clusters` block, or any future `name: "X"` per-chain entry pointing at a separate `$X` metadata block), add a test that asserts every name used in the per-chain entries has a corresponding metadata entry. A typo in either side silently breaks the consumer (e.g. `getClusterMetadata("cluster-7dc08ec28f299c07")` returning `undefined` if you typo the address by one digit). This was caught during PR #316 review.

### Indexer RPC self-heal (`rpc.ts`)

- Multi-getter RPC helpers (`fetchFees` etc.) use `Promise.allSettled` + distinct sentinels: `-1` = not yet attempted (retry), `-2` = viem "returned no data" signature = getter missing from bytecode (stop retrying). All-or-nothing `Promise.all` loses wins from fulfilled getters; a single sentinel creates forever-retry loops on older deployments lacking a getter (bit us on PR #222)
- Every `rpc.ts` helper that calls `getRpcClient` wraps it in try/catch. `getRpcClient` throws synchronously on unknown chainIds + missing HyperRPC tokens; unwrapped throws escape into handlers and stall indexing. Regressed twice in PR #222 — if you touch fee/rebalancing RPC helpers, check the outer guard is still in place

### Terraform + Cloud Run — `docs/pr-checklists/terraform-cloudrun.md`

tldr: rename/remove resources REQUIRE a `moved` block (`deletion_protection = true` makes a missed `moved` block fatal). Cloud Run `--revision-suffix` MUST start with a lowercase letter (RFC 1035) AND be unique per run (`$GITHUB_RUN_ID`). Probe path is `/health`, NEVER `/healthz` (Cloud Run v2 reserves `/healthz`). Bootstrap `image` MUST respond to the configured probe path. WIF requires `roles/iam.serviceAccountTokenCreator` on the runtime SA the deployer impersonates. Full rules in the linked checklist.

### CI workflow gates — `docs/pr-checklists/ci-workflow-gates.md`

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

- CSP `connect-src` MUST include every Hasura + RPC endpoint the dashboard calls (source of truth: `ui-dashboard/src/lib/csp.ts`'s `CSP_CONNECT_SRC`)
- Do NOT widen `script-src` with `unsafe-eval` without proof a library actually needs it — the current policy is deliberately tight and Plotly runs fine without it
- Auth/allowlist constants must be centralized — don't repeat domain literals across files

### Migration discipline

- Don't remove an env-var fallback in the same PR that introduces the new var. Keep dual-read for one release so mid-deploy state doesn't break

### Dynamic-route metadata + private data — `docs/pr-checklists/dynamic-route-metadata.md`

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

### Code health budgets — `docs/pr-checklists/code-health.md`

CodeScene-equivalent OSS quality checks. These shipped tier-by-tier; the
ratchet is now fully in place.

- **Cross-package boundaries (blocking, `pnpm code-health:deps`)**: `indexer-envio` is isolated; `ui-dashboard`, `metrics-bridge`, and `aegis` must not import each other's internals; `shared-config` is a leaf. New cross-package imports MUST be justified or routed through `shared-config`. Config-data JSON under `indexer-envio/config/**` is the one allowed escape hatch for the dashboard (used by cross-validation tests).
- **No circular dependencies (blocking)**: `pnpm code-health:deps` fails on any cycle. The historical `indexer-envio/src/{pool,deviationBreach}.ts` cycle was broken by importing health predicates directly from `pool/health.js`; no baseline carve-out remains.
- **Dashboard lib/ → components/ direction (blocking, `pnpm code-health:deps`)**: `ui-dashboard/src/lib/` must not import from `src/components/`. The allowed direction is `components/ → lib/` (components use utilities, never the reverse). Violations indicate lib has accidentally coupled pure logic to the render layer. Pre-inventory: zero violations; rule ships at `error`.
- **Dashboard route-private directories (blocking, `pnpm code-health:deps`)**: `_components/` and `_tabs/` directories inside `app/<route>/` are private to that route. Code from `app/<route-A>/` must not import from `app/<route-B>/_components/` or `app/<route-B>/_tabs/`. Adding a new route with a `_components/` or `_tabs/` directory requires a matching `dashboard-route-private-<routename>` rule in `.dependency-cruiser.cjs`. Pre-inventory: zero violations; rules ship at `error`.
- **Indexer handlers must not bypass the RPC effect layer (blocking, `pnpm code-health:deps`)**: `indexer-envio/src/handlers/**` must not import directly from `rpc/` implementation files (`rpc/pool-state.ts`, `rpc/oracle-state.ts`, `rpc/biPoolManager.ts`, `rpc/breakers.ts`, etc.). Handlers must go through `rpc/effects.ts` (the Envio Effect API facade, which provides per-batch memoisation, deduplication, and rate-limiting) or the `rpc.ts` barrel (for DB helpers like `getPoolsByFeed`). Direct fetcher imports bypass effect deduplication and fire two RPC reads per event instead of one. Pre-inventory: zero violations; rule ships at `error`.
- **Dead-code / dep hygiene (blocking, `pnpm --filter <pkg> knip`)**: every package runs `knip` in strict mode. Unused files / unlisted deps / binary entries are errors. Unused exports + types are warns — clean them when you touch the file. Peer-dep build tools (axe-core, tailwindcss, @stryker-mutator/api) go in `ignoreDependencies` with a 1-line "why" in this checklist.
- **Complexity / size / cognitive-complexity budgets (blocking, diff-aware baseline)**: per-package thresholds for `complexity`, `max-lines-per-function`, `max-depth`, `max-params`, plus `eslint-plugin-sonarjs` (cognitive-complexity + 4 suspicious-pattern rules). Strictest on `shared-config`; loosest inside `indexer-envio/src/handlers/**`. Pre-existing violations live in each package's `eslint-baseline.json`; new violations fail `pnpm --filter <pkg> lint` via `scripts/eslint-baseline-diff.mjs`. See `docs/pr-checklists/code-health.md`.
- **Duplication detection (advisory, `pnpm code-health:duplication`)**: `jscpd` scans `src/` across all packages and standalone function roots on every PR (excluding tests, `indexer-envio/src/handlers/**`, route entry pages, pure type modules, and the intentionally vendored `quicknode-hmac.ts` / `gcp-logger.ts` copies — per-package drift tests enforce byte-identity for those). The CI job is non-blocking — surfaces a comment-summary + an artifact in `reports/jscpd/`. Use the artifact to plan extract-helper refactors.
- **Code-health history report (advisory, `pnpm code-health:history`)**: writes `reports/code-health-history.md` with hotspots, change-coupling, ownership concentration, weekly delta. Run before large refactors so the targets are picked from data, not vibes. Weekly cron + Slack delivery in a follow-up PR.
- **Per-package coverage floors (blocking, `pnpm --filter <pkg> test:coverage` or Aegis `test:cov`)**: coverage thresholds enforce a floor so deleting tests can't silently lower coverage below the baseline. Vitest packages keep `coverage.thresholds` in each `vitest.config.ts`; Aegis keeps Jest `coverageThreshold` in its Jest config. Floors are calibrated at `floor(measured) - 2` to absorb variance. CI and the local agent quality gate call coverage commands, not bare `test`, for all seven workspace packages with test suites. When adding significant new code, re-measure and raise the floors accordingly.
- **Mutation score gates (advisory, `pnpm {bridge,dashboard,indexer}:mutation`)**: `.github/workflows/mutation-testing.yml` runs three per-package jobs on the weekly `schedule` cron + `workflow_dispatch` only — **not** per-PR. It is not in the `main` ruleset's required checks; per-PR mutation testing (3 runner boots per push) was removed as a CI-cost control (mutation measures test-suite strength, not per-commit regression — weekly is the right cadence). Run on demand for a branch via the GitHub "Run workflow" button. Every job keeps its inline `filter`/`decide` steps; on a non-`pull_request` trigger the mutation step always runs. `break` floors are calibrated at `floor(measured) − 2` for measurement noise: `metrics-bridge/stryker.config.mjs` `break: 84` (baseline 86.01%), `ui-dashboard/stryker.config.mjs` `break: 86` (baseline 88.81%), `indexer-envio/stryker.config.mjs` `break: 92` (baseline 94.19%). Surviving mutants must be classified as equivalent / accepted noise in `docs/mutation-testing.md` or fixed with a new test in the same PR. See `docs/pr-checklists/mutation-testing.md`.
- **Type-aware async safety + exhaustive switches (blocking, diff-aware baseline)**: `@typescript-eslint/no-floating-promises`, `no-misused-promises`, and `switch-exhaustiveness-check` are `error` on all four packages. Floating-promises catches missing `await`; misused-promises catches passing async callbacks where a void return is expected (use `void doSomething()` or wrap in a sync callback); switch-exhaustiveness forces every discriminated-union / enum switch to cover every variant. `ui-dashboard` configures `no-misused-promises` with `checksVoidReturn.attributes: false` so React event-handler attributes (`<button onClick={async () => ...}>`) are allowed — the synthetic event system swallows rejections correctly. Non-attribute void-return contexts (`setTimeout(async ...)`, function arguments, etc.) still fire and caught the `poller.ts` + `gql-retry.ts` bugs in this PR. Type-aware rules are scoped to `src/**/*.{ts,tsx}` minus `*.d.ts` + tests (the TS project service doesn't pick those up, and async tests are intentionally noisy).
- **`noUncheckedIndexedAccess` (blocking via `pnpm <pkg> typecheck`)**: `shared-config`, `indexer-envio`, `metrics-bridge`, `aegis`, and `ui-dashboard` all ship with the TS compiler flag on — `arr[i]` is typed as `T | undefined`, forcing explicit guards on every index access. The `ui-dashboard` burn-down completed via issues #666–#671 (the flag was flipped once every bucket reached zero).
- **`exactOptionalPropertyTypes` (blocking via `pnpm <pkg> typecheck`)**: all four packages ship with this flag — `{ x?: T }` (absent key) is distinct from `{ x: T | undefined }` (present but undefined). Assigning `undefined` to an optional property is an error; omit the key instead (spread pattern: `...(val !== undefined && { key: val })`), or widen the destination type to `?: T | undefined` when the value really can be present-and-undefined. The dashboard rollout widened helper signatures rather than spreading at every call site because Plotly/SWR and some GraphQL call shapes still require positional `undefined` arguments — `lib/types.ts` `Pool`, `lib/networks.ts` `Network`, `lib/health.ts` predicates, and `lib/address-labels-shared.ts` `AddressEntry` are the canonical examples.
- **`verbatimModuleSyntax` (blocking via `pnpm <pkg> typecheck`)**: `shared-config` ships with this flag — every type-only import must use `import type { ... }` syntax; value imports use plain `import`. Prevents accidental runtime imports of pure types, makes intent explicit, and plays well with `isolatedModules`. `indexer-envio`, `metrics-bridge`, and `ui-dashboard` remain on the ratchet backlog.
- **Bundle size gate (advisory, `pnpm dashboard:size-limit`)**: `.github/workflows/size-limit.yml` runs only on PRs that touch dashboard build inputs (workflow-level `paths:` filter mirroring the in-job `filter` globs). It is **not** in the `main` ruleset's required checks, so the `paths:` filter is safe (CI-cost control — see `ci-workflow-gates.md` §1). The in-job inline `filter` step (`continue-on-error: true`) + `decide` step are kept as a fail-closed backstop — the build + size check runs when the filter failed or when the diff touched dashboard inputs. Budgets and current baseline live in `ui-dashboard/.size-limit.cjs` (source of truth — brotli-compressed, manifest-referenced `.next/static/` assets, budget = baseline × 1.10). To tighten: `pnpm dashboard:build && pnpm dashboard:size-limit --json`, update limits in `.size-limit.cjs`, commit the updated baseline comment.
- **Lockfile integrity + registry + override-floor check (blocking, `pnpm lockfile:lint`)**: `scripts/lockfile-lint.mjs` validates pnpm-lock.yaml and repo package-manager config on every PR via `.github/workflows/supply-chain.yml`. Three checks: (1) every package in the `packages:` section has a valid sha512 integrity hash — prevents tampered-tarball installs; (2) every `.npmrc` and `pnpm-workspace.yaml` discovered by walking the repo (excluding `.git/`, `.claude/`, and `node_modules/`) is verified to NOT redirect to a non-canonical host (exact-match host check, not prefix — lookalikes like `registry.npmjs.org.evil.com` are rejected); (3) root `package.json` `pnpm.overrides`, root `resolutions`, and every discovered `pnpm-workspace.yaml` override selector/value avoids unbounded minimum floors (`>` / `>=` or open hyphen ranges without an upper bound), including `catalog:` / `catalog:<name>` indirection; unresolved catalog references, pnpm `$` override references, YAML aliases, and YAML block scalars are rejected so the audit sees the resolved replacement directly. Note: pnpm v9 no longer embeds `resolved:` URLs in the lockfile (unlike npm/yarn), so the `lockfile-lint` npm package cannot parse it; the check is a custom Node.js script with zero additional deps. CI job is sub-30s (no `pnpm install`). pnpm patch files under `patches/**` are package-manager inputs too: patch-only changes must route through frozen install and package quality gates because the lockfile records patch hashes. Part of the "Package-Manager Supply-Chain Hardening" thread.
- **Override floors are resolution-time snapshots (weekly report, `supply-chain.yml` `moderate-advisory-report`)**: `pnpm.overrides` / root `resolutions` floors (`>=x.y.z`) and carets only act when the lockfile (re)resolves — they go stale in place when a new advisory raises the patch line, and blanket floors can jump majors on a fresh resolve (the undici 6→8 incident; #837). `pnpm lockfile:lint` now rejects unbounded minimum override/resolution values; use range-scoped exact pins (`pkg@<x.y.z: x.y.z`), bounded selector ranges, or same-major/capped replacement values instead. When an advisory supersedes an override's floor, bump the scoped override and run `pnpm install` to re-resolve, then diff `pnpm-lock.yaml` for unexpected major jumps. If an upstream package pins the vulnerable transitive exactly and forcing an override is known-bad, use a parsed `pnpm audit --json` exception scoped by advisory, module, version, and exact dependency path instead of a blanket ignore; if that replaces a required OSV lockfile scan, run the parsed gate from a required check. The weekly moderate-level audit job keeps sub-high advisories visible across the root and standalone deploy lockfiles via the `security-advisories` issue. The mirror side of the same problem — an override whose floor the graph has since cleared naturally, or a `minimumReleaseAgeExclude` bypass that's outlived the advisory batch it was added for — is now surfaced automatically by the weekly `supply-chain.yml` `override-prune-report` job (`scripts/override-prune-report.mjs`, `pnpm override:prune-report`): a heuristic, report-only table posted to the "Supply chain: override prune report" issue. It never edits config; pruning a flagged entry is still a human-reviewed follow-up PR.
- **Catalog version-skew check (blocking, `pnpm skew:check`)**: `scripts/version-skew-check.mjs` enforces that every manifest entry for a cataloged package is either `catalog:` or exactly the catalog version. Use `catalog:` only in packages that are always installed from the root workspace; standalone deploy roots such as `indexer-envio`, `aegis`, `governance-watchdog`, and alerts functions keep literal pins and rely on this check to prevent drift. Add a fixture to `scripts/version-skew-check.test.mjs` when the catalog gains semantics beyond exact pin equality.
- **Core Web Vitals + accessibility gate (`lhci autorun` + INP via Playwright)**:
  `.github/workflows/lighthouse.yml` runs only on PRs that touch dashboard
  inputs or the workflow itself. The workflow-level `paths:` filter mirrors the
  in-job fixture filter; a narrower preview filter mirrors the paths Vercel
  builds. It is advisory, so the workflow-level filter is safe.
  The gate polls the Vercel preview URL (5-minute timeout), then runs three
  Lighthouse collections each against `/`, `/pools`, `/volume`, and canonical
  pool detail
  `/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e?lhci=live`
  for accessibility, performance, LCP, and CLS. The preview remains the source
  of truth for the real deployed bundle/host, Vercel edge/network behavior,
  production analytics/Sentry, and live-indexer latency. Accessibility
  (≥ 0.94), performance (≥ 0.75), and CLS (≤ 0.10) remain shared and blocking.
  Root and `/pools` LCP remain blocking at 1 700 ms; `/volume` remains blocking
  at 2 440 ms, backed by the 2026-07-15 values (1 981.264, 1 885.954, and
  1 940.190 ms). The live pool still measures the unchanged 1 700 ms ceiling,
  but emits a warning because one unchanged preview produced 927–2 640 ms
  samples with 90%+ of LCP attributed to element render delay from live
  indexer/SSR/client scheduling.

  `pnpm dashboard:lighthouse:pool-fixture` owns the blocking pool-detail
  contract. It builds the real production dashboard against the local Hasura
  fixture, verifies the exact SSR breaker and Volume values through deliberately
  delayed client breaker revalidation in Playwright, and collects three
  canonical `?lhci=fixture` runs with median LCP blocking above the same 1 700 ms
  ceiling. The runner requires one completed delayed breaker request per browser
  audit and inspects `assertion-results.json` to prove the blocking assertion
  actually ran across all three numeric values. Fixture mode isolates app
  render/hydration cost; it deliberately excludes Vercel edge/network variance,
  production analytics/Sentry, and live-indexer latency. Exact query markers
  make the live warning and fixture error patterns non-overlapping, while all
  non-LCP assertions remain mechanically identical and blocking.

  `ui-dashboard/scripts/measure-inp.mjs` separately drives `/pools` filter,
  `/volume` time-window and sort, and canonical pool TVL-range interactions;
  per-surface INP remains blocking at ≤ 200 ms. The fail-closed
  `assert-lhci-finalurl.mjs` guard still requires exactly 12 preview reports—the
  complete 3-runs × 4-path matrix—with no redirect, Lighthouse runtime error, or
  main-document 4xx/5xx. Live and fixture per-run diagnostics are appended to
  the sticky PR comment when a preview exists; trusted workflow-only/ignored
  preview runs update that same comment with a fixture-only status so an older
  result cannot remain misleading. The full
  `ui-dashboard/reports/lighthouse-pool/` directory is uploaded even on
  failure. The combined job has a 30-minute
  timeout for the preview plus deterministic production-build phase. Fork and
  Dependabot PRs still run the secretless deterministic fixture, but skip the
  Vercel preview, PR comment, and INP lanes that require trusted secrets or
  write permissions. The Vercel protection bypass remains confined to trusted
  workflow shell and requires both `x-vercel-protection-bypass` and
  `x-vercel-set-bypass-cookie: true`; the fixture command receives neither
  secret. The preview final-URL guard and diagnostics both require the exact
  `?lhci=live` pathname/query target; fixture diagnostics require the exact
  `?lhci=fixture` target. `scripts/lighthouse-config.test.mjs` exercises exact
  pattern non-overlap, warning/error severity, thresholds, and median aggregation
  through the installed LHCI CLI. Pairs with `size-limit.yml` (bundle bytes),
  which covers a different failure class.

- **GraphQL schema diff (advisory, `pnpm code-health:schema-diff`)**: `.github/workflows/schema-diff.yml` runs on every PR (no workflow-level `paths:` filter — intentionally). It posts a sticky comment and clears it when the schema reverts to base, so it must stay unfiltered: a `paths:` skip on a revert PR would strand the stale comment (the cleanup step never runs). Run/skip is decided in-job via the inline `filter` step + `decide` step — the diff runs only when `indexer-envio/schema.graphql` changed (fail-closed on path-detection error). Uses `graphql`'s `findBreakingChanges` + `findDangerousChanges` to compare `origin/<base>:indexer-envio/schema.graphql` against `HEAD`. Results posted as a sticky PR comment (header `schema-diff`); exit code always 0 (advisory). Breaking changes (removals, type narrowing, new required args) surfaced prominently; dangerous changes (default shifts, new optional fields) listed separately; safe additions skipped. Local run: `pnpm code-health:schema-diff`. Promotion to blocking is a follow-up once real-PR signal has been collected.
- **Env-var validation (pattern — `src/env.ts` per package)**: each package parses `process.env` through Zod at module load and exports typed constants (`env` for indexer-envio + metrics-bridge; `clientEnv` from `ui-dashboard/src/env.ts`; `serverEnv` from `ui-dashboard/src/server-env.ts`). Use `.catch(default)` (not `.default()`) for numeric/enum fields that have a fallback so invalid values silently resolve instead of throwing. The dashboard client schema uses `zod/mini`; its full-Zod server schema is isolated in `server-env.ts` so client imports cannot retain full Zod in browser chunks. Never import `serverEnv` from a client component. Files whose tests manipulate `process.env` at test time (via `vi.stubEnv`) keep direct `process.env` reads; the static parse runs before any test hook fires. Dynamic computed-key reads (`process.env[config.envVar]`) also stay as-is.
