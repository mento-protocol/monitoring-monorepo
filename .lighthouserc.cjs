// Lighthouse CI configuration for the ui-dashboard.
//
// BASELINES (production prod measurement 2026-05-18 + first real CI run
// 2026-05-27 against the Vercel preview after the bypass cookie + GitHub
// secret sync landed; CLS rebaselined 2026-05-28 after PR #652 SSR fix):
//   Accessibility: 0.94  (prod; deterministic across runs)
//   Performance:   silent-passed ≥ 0.75 floor on every URL
//   LCP:           silent-passed ≤ 1 700 ms on every URL (prod baseline ~1 200 ms)
//   CLS:           0.0000 on /pools (deterministic across 3 prod runs after
//                  PR #652 SSR fix; pre-fix was 0.4896)
//   INP:           40 ms on /pools filter interaction (web-vitals; ≪ 200 ms budget)
//
// BUDGET RATIONALE:
//   Accessibility + Performance + LCP + CLS are now `error` (blocking).
//   Accessibility because the score is deterministic; Performance + LCP
//   because the first empirical CI run passed them comfortably without
//   any dashboard change; CLS because PR #652 (SSR /pools initial pool
//   list) eliminated the deterministic 0.4896 layout shift and 3 post-
//   merge prod runs reported 0.0000. CI runner load variance is real
//   but the headroom (perf score 5 points below the typical run,
//   LCP 500 ms above, CLS 0.10 vs measured 0) absorbs it.
//
//   Headroom applied:
//     performance score:  baseline - 0.05  (error at <0.75 → catches big regressions)
//     LCP:                baseline + 500 ms (error at >1 700 ms)
//     CLS:                0.10 (error; standard web-vitals "good" threshold)
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
        // (`ui-dashboard/scripts/assert-lhci-finalurl.mjs` parses each
        // report's `finalUrl` and asserts host + pathname match the
        // preview — a bypass regression, wrong-project deployment, or
        // unexpected redirect all fail closed).
        "categories:accessibility": ["error", { minScore: 0.94 }],

        // Largest Contentful Paint: error above 1 700 ms
        // Baseline ~1 200 ms desktop + 500 ms headroom. First real CI run
        // with the bypass working (PR #614) silent-passed both URLs well
        // under 1 700 ms, so promoting to `error` doesn't demand any
        // dashboard change. Catches LCP regressions on the first commit
        // that introduces them, rather than waiting for an engineer to
        // notice the lhci `⚠️` line.
        "largest-contentful-paint": ["error", { maxNumericValue: 1700 }],

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
        // click) and /leaderboard (time-window switch, column sort), and
        // the web-vitals library reports the real Event-Timing-API INP
        // for each. Each surface is asserted independently against the
        // INP_BUDGET_MS budget (default 200 ms, web-vitals "good"
        // threshold).
      },
    },
    upload: {
      // Use temporary-public-storage for report hosting (no LHCI server needed).
      // The URL is posted to the PR comment by the workflow.
      target: "temporary-public-storage",
    },
  },
};
