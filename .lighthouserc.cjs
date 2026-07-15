// Lighthouse CI configuration for the ui-dashboard.
//
// BASELINES (production measurement 2026-05-18 + first real CI run 2026-05-27
// against the Vercel preview after the bypass cookie + GitHub secret sync
// landed; CLS rebaselined 2026-05-28 after PR #652 SSR fix):
//   Accessibility: 0.94  (prod; deterministic across runs)
//   Performance:   silent-passed ≥ 0.75 floor on both original URLs
//   LCP:           silent-passed ≤ 1 700 ms on both original URLs
//                  (prod baseline ~1 200 ms)
//   CLS:           0.0000 on /pools (deterministic across 3 prod runs after
//                  PR #652 SSR fix; pre-fix was 0.4896)
//   INP:           40 ms on /pools filter interaction (web-vitals; ≪ 200 ms budget)
//
//   Route coverage expanded on 2026-07-15. The first real 3-run Vercel preview
//   completed for all four routes. `/volume` measured LCP at 1 981.264,
//   1 885.954, and 1 940.190 ms; the per-metric median baseline is 1 940.190 ms.
//   The audited route also measured performance 0.91,
//   accessibility 0.95, and CLS 0.000716. Applying the existing convention
//   (per-metric median rounded to 1 940 ms + 500 ms headroom) sets only
//   `/volume` to 2 440 ms. The other three routes retain
//   the shared 1 700 ms LCP ceiling and every other assertion remains shared.
//
//   The 2026-07-15 workflow took 5m10 total, including 3m10 for LHCI, leaving
//   14m50 headroom under the job's 20-minute timeout.
//
// BUDGET RATIONALE:
//   Accessibility + Performance + LCP + CLS are now `error` (blocking).
//   Accessibility because the score is deterministic; Performance + LCP
//   because the first empirical CI run passed them comfortably without
//   any dashboard change; CLS because PR #652 (SSR /pools initial pool
//   list) eliminated the deterministic 0.4896 layout shift and 3 post-
//   merge prod runs reported 0.0000. CI runner load variance is real
//   but the headroom (perf score 5 points below the original typical run,
//   route-calibrated LCP +500 ms, CLS 0.10 vs measured near 0) absorbs it.
//
//   Headroom applied:
//     performance score:  baseline - 0.05  (error at <0.75 → catches big regressions)
//     LCP:                baseline + 500 ms (error at >1 700 ms normally;
//                         >2 440 ms on evidence-backed `/volume` only)
//     CLS:                0.10 (error; standard web-vitals "good" threshold)
//     INP:                200 ms (in measure-inp.mjs; web-vitals "good" threshold)
//     accessibility:      0.94 (error; matches current prod baseline)
//
// PAGES AUDITED:
//   Injected at workflow runtime through repeated `--collect.url` flags:
//     /
//     /pools
//     /volume
//     /pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e
//   The pool-detail target is the canonical Celo USDC/USDm pool. Its immutable,
//   chain-qualified ID is shared with the INP gate and browser fixtures.

const NON_VOLUME_URL_PATTERN =
  /^https?:\/\/[^/]+(?:\/|\/pools|\/pool\/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e)(?:[?#]|$)/
    .source;
const VOLUME_URL_PATTERN = /^https?:\/\/[^/]+\/volume(?:[?#]|$)/.source;

/**
 * Keep every assertion identical across routes except for the evidence-backed
 * LCP ceiling supplied by the assert-matrix entry.
 *
 * @param {number} lcpMaxNumericValue
 */
function assertionsWithLcpCeiling(lcpMaxNumericValue) {
  return {
    // Performance score: error below 0.75 (desktop SSR, production
    // baseline ~0.80). First real CI run with the bypass working
    // (PR #614 on commit a9e4a5a4) silent-passed both original URLs well above
    // the 0.75 floor, so promoting from `warn` to `error` doesn't
    // demand any dashboard change. The 5-point headroom catches any
    // material regression while staying clear of CI runner load
    // variance.
    "categories:performance": ["error", { minScore: 0.75 }],

    // Accessibility score: error below 0.94
    // Production measured at 0.94 on 2026-05-18. Threshold matches
    // baseline so any regression blocks the PR.
    //
    // Blocking is safe because (a) Lighthouse's accessibility category
    // is deterministic across runs — it only changes on real code
    // diffs — (b) the deployment-protection bypass now reliably
    // delivers Lighthouse to the dashboard rather than the SSO
    // interstitial (the workflow's extraHeaders include
    // `x-vercel-set-bypass-cookie: true` so the auth cookie is set on
    // the first response and carries across subresources), and
    // (c) the workflow includes a fail-closed audited-page guard
    // (`ui-dashboard/scripts/assert-lhci-finalurl.mjs` parses each
    // report's `finalUrl` and asserts host + pathname match the
    // preview — a bypass regression, wrong-project deployment, or
    // unexpected redirect all fail closed).
    "categories:accessibility": ["error", { minScore: 0.94 }],

    // Largest Contentful Paint: error above the route's calibrated ceiling.
    // `/`, `/pools`, and canonical pool detail retain 1 700 ms. `/volume`
    // uses the documented 2 440 ms evidence-backed ceiling. Both apply the
    // same baseline + 500 ms convention.
    "largest-contentful-paint": [
      "error",
      { maxNumericValue: lcpMaxNumericValue },
    ],

    // Cumulative Layout Shift: error above 0.10
    // PR #652 (SSR /pools initial pool list via `fetchAllNetworks` as
    // SWR `fallbackData`) eliminated the deterministic 0.4896 shift
    // that had blocked promotion. Post-merge prod measurement on
    // 2026-05-28 reported CLS = 0.0000 across 3 runs; the merge-PR's
    // own lhci against the Vercel preview reported 0.0102. Both are
    // far below the 0.10 web-vitals "good" threshold, so the budget
    // has comfortable headroom for runner-variance noise.
    "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],

    // NOTE: INP (interaction-to-next-paint) is intentionally NOT asserted
    // here. Lighthouse's default navigation mode (cold page load, no user
    // interactions) never produces an INP numeric value, so a `warn` /
    // `error` budget at this layer would silently pass on every run.
    //
    // INP is asserted in a separate workflow step that runs
    // `ui-dashboard/scripts/measure-inp.mjs` — Playwright drives a
    // set of scripted interactions on /pools (filter input + Apply
    // click), /volume (time-window switch, column sort), and
    // /pool/[poolId] (TVL chart range button click on the canonical
    // Celo USDC/USDm pool), and the web-vitals library reports the
    // real Event-Timing-API INP for each. Each surface is asserted
    // independently against the INP_BUDGET_MS budget (default 200 ms,
    // web-vitals "good" threshold).
  };
}

/** @type {import('@lhci/cli').LighthouseRcConfig} */
module.exports = {
  ci: {
    collect: {
      // URLs are injected by the workflow through repeated `--collect.url` flags.
      // The collect block intentionally has no `url` field here — the workflow
      // passes --collect.url=... flags directly to `lhci autorun` so that the
      // preview URL is embedded at runtime rather than hardcoded here.
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        // Skip PWA checks — the dashboard is not a PWA.
        skipAudits: [
          "installable-manifest",
          "service-worker",
          "splash-screen",
          "themed-address-bar",
          "maskable-icon",
        ],
      },
    },
    assert: {
      // `warn` = advisory (non-blocking); `error` = blocking. `assertMatrix`
      // scopes the single evidence-backed exception to `/volume`; using one
      // assertion factory keeps the remaining budgets mechanically identical.
      assertMatrix: [
        {
          matchingUrlPattern: NON_VOLUME_URL_PATTERN,
          assertions: assertionsWithLcpCeiling(1700),
        },
        {
          matchingUrlPattern: VOLUME_URL_PATTERN,
          assertions: assertionsWithLcpCeiling(2440),
        },
      ],
    },
    upload: {
      // Use temporary-public-storage for report hosting (no LHCI server needed).
      // The URL is posted to the PR comment by the workflow.
      target: "temporary-public-storage",
    },
  },
};
