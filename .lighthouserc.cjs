// Lighthouse CI configuration for the ui-dashboard.
//
// BASELINES (production prod measurement 2026-05-18 + first real CI run
// 2026-05-27 against the Vercel preview after the bypass cookie + GitHub
// secret sync landed):
//   Accessibility: 0.94  (prod; deterministic across runs)
//   Performance:   silent-passed ≥ 0.75 floor on every URL
//   LCP:           silent-passed ≤ 1 700 ms on every URL (prod baseline ~1 200 ms)
//   CLS:           0.4896 on /pools (deterministic across 3 runs — a real
//                  hydration shift, NOT measurement noise; tracked in BACKLOG)
//   INP:           40 ms on /pools filter interaction (web-vitals; ≪ 200 ms budget)
//
// BUDGET RATIONALE:
//   Accessibility + Performance + LCP are now `error` (blocking).
//   Accessibility because the score is deterministic; Performance + LCP
//   because the first empirical CI run passed them comfortably without
//   any dashboard change. CI runner load variance is real but the
//   headroom (perf score 5 points below the typical run, LCP 500 ms
//   above) absorbs it. CLS stays `warn` until the /pools hydration shift
//   is fixed — promoting to `error` now would block every dashboard PR
//   on a known bug at the gate level.
//
//   Headroom applied:
//     performance score:  baseline - 0.05  (error at <0.75 → catches big regressions)
//     LCP:                baseline + 500 ms (error at >1 700 ms)
//     CLS:                0.10 (warn — deliberately tighter than the
//                         current /pools value so the regression stays
//                         visible; tracked in BACKLOG)
//     INP:                200 ms (in measure-inp.mjs; web-vitals "good" threshold)
//     accessibility:      0.94 (error; matches current prod baseline)
//
// PAGES AUDITED:
//   Injected at workflow runtime from LHCI_URLS env var (comma-separated).
//   The workflow sets this to the Vercel preview URL for the homepage and the
//   pools index page. Pool detail pages are excluded because they require a
//   valid pool address in the path, which changes per deployment.

/** @type {import('@lhci/cli').LighthouseRcConfig} */
module.exports = {
  ci: {
    collect: {
      // URLs are injected by the workflow via LHCI_URLS (comma-separated).
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
      // `warn` = advisory (non-blocking); `error` = blocking.
      // See budget rationale above.
      assertions: {
        // Performance score: error below 0.75 (desktop SSR, production
        // baseline ~0.80). First real CI run with the bypass working
        // (PR #614 on commit a9e4a5a4) silent-passed every URL well above
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
        // (greps lhci stdout for `vercel.com/login` — a bypass regression
        // is loud, not silent). Promotion to a manifest-based finalUrl
        // check is tracked in BACKLOG.
        "categories:accessibility": ["error", { minScore: 0.94 }],

        // Largest Contentful Paint: error above 1 700 ms
        // Baseline ~1 200 ms desktop + 500 ms headroom. First real CI run
        // with the bypass working (PR #614) silent-passed both URLs well
        // under 1 700 ms, so promoting to `error` doesn't demand any
        // dashboard change. Catches LCP regressions on the first commit
        // that introduces them, rather than waiting for an engineer to
        // notice the lhci `⚠️` line.
        "largest-contentful-paint": ["error", { maxNumericValue: 1700 }],

        // Cumulative Layout Shift: warn above 0.10 (intentionally NOT
        // promoted to error in this PR). First real CI run with the
        // bypass working (PR #614) measured CLS = 0.4896 deterministically
        // on /pools — all three runs identical. That's a real, consistent
        // layout shift during /pools hydration, not measurement noise.
        // Promoting to `error` at 0.10 would block every dashboard PR
        // until the underlying shift is fixed; widening the budget to
        // cover 0.49 would hide the regression at the gate level. Leave
        // as `warn` so the `⚠️` line stays visible while the fix is in
        // BACKLOG.
        "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],

        // NOTE: INP (interaction-to-next-paint) is intentionally NOT asserted
        // here. Lighthouse's default navigation mode (cold page load, no user
        // interactions) never produces an INP numeric value, so a `warn` /
        // `error` budget at this layer would silently pass on every run.
        //
        // INP is asserted in a separate workflow step that runs
        // `ui-dashboard/scripts/measure-inp.mjs` — Playwright drives a
        // set of scripted interactions on /pools (filter input + Apply
        // click) and /leaderboard (time-window switch, column sort), and
        // the web-vitals library reports the real Event-Timing-API INP
        // for each. Each surface is asserted independently against the
        // INP_BUDGET_MS budget (default 200 ms, web-vitals "good"
        // threshold). Pool-detail chart hover coverage is tracked in
        // BACKLOG.
      },
    },
    upload: {
      // Use temporary-public-storage for report hosting (no LHCI server needed).
      // The URL is posted to the PR comment by the workflow.
      target: "temporary-public-storage",
    },
  },
};
