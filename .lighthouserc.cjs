// Lighthouse CI configuration for the ui-dashboard.
//
// BASELINES (measured 2026-05-18, desktop, monitoring.mento.org):
//   Accessibility: 0.94  (production; see CI run in PR that introduced this)
//   Performance:   not captured by CI tool; conservative desktop estimate used
//   LCP:           ~1 200 ms  (SSR + CDN-served, desktop)
//   CLS:           0.00       (measured directly via Lighthouse JSON)
//   INP:           not captured by Lighthouse navigation mode (needs user-flow)
//
// BUDGET RATIONALE:
//   All performance budgets start as `warn` (not `error`) because CWV vary
//   run-to-run and are sensitive to CI runner load. They are early warnings,
//   not hard blocks. Accessibility starts as `error` because it is
//   deterministic across runs and the score only degrades on code changes.
//
//   Headroom applied:
//     performance score:  baseline - 0.05  (warn at <0.75 → catches big regressions)
//     LCP:                baseline + 500 ms (warn at >1 700 ms)
//     CLS:                max(baseline + 0.05, 0.10) = 0.10
//     INP:                (not asserted; navigation mode doesn't produce a value)
//     accessibility:      0.94 (error; matches current prod baseline 0.94 so
//                         any regression is caught without blocking current PRs)
//
// WARN → ERROR PROMOTION:
//   Once the CI infrastructure has collected 5+ stable runs and a representative
//   percentile distribution is known, promote performance budgets from `warn`
//   to `error`. Tracked in BACKLOG under "Lighthouse CI Follow-Ups".
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
        // Performance score: warn below 0.75 (desktop SSR, production baseline ~0.80)
        "categories:performance": ["warn", { minScore: 0.75 }],

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

        // Largest Contentful Paint: warn above 1 700 ms
        // Baseline ~1 200 ms desktop + 500 ms headroom.
        "largest-contentful-paint": ["warn", { maxNumericValue: 1700 }],

        // Cumulative Layout Shift: warn above 0.10
        // Production measured at 0.00. Using standard "good" threshold.
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
