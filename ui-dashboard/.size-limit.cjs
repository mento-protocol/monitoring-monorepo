// Size budgets for the Next.js 16 (Turbopack) dashboard build output.
//
// WHY GLOB TARGETS (not entry points):
// Turbopack produces content-hashed filenames (e.g. `0xewy2a70rsnd.js`)
// that change on every build. @size-limit/preset-app / webpack-based presets
// can't bundle from entry points in App Router with Turbopack.
// @size-limit/file + glob over the already-built `.next/static/` directory
// is the correct approach: it measures the actual bytes the browser downloads.
//
// HOW TO UPDATE BUDGETS:
// 1. Run `pnpm dashboard:build` to get a fresh `.next/` output.
// 2. Run `pnpm --filter @mento-protocol/ui-dashboard exec size-limit --json`
//    to measure current sizes.
// 3. Set budget to current_bytes × 1.10 (10% headroom).
// 4. Update the comments below with the new baseline + date.
//
// BASELINE (measured 2026-05-18 with Next.js 16.2.6 + Turbopack):
//   All client JS chunks (brotli): 1,702,785 bytes (1.62 MB)
//   All CSS (brotli):              10,283 bytes (10.0 KB)

/** @type {import('size-limit').SizeLimitConfig} */
module.exports = [
  {
    // All client-side JavaScript emitted by Turbopack under .next/static/chunks/.
    // This is what the browser downloads (brotli-compressed in prod via CDN).
    // Dominant contributor is plotly.js-basic-dist-min (~1.3 MB brotli).
    //
    // Baseline: 1,702,785 bytes  Budget: ×1.10 = 1,873,064 bytes → 1830 KB
    name: "All client JS chunks",
    path: [".next/static/chunks/**/*.js"],
    limit: "1830 kB",
  },
  {
    // All CSS emitted under .next/static/ (single Tailwind v4 bundle).
    //
    // Baseline: 10,283 bytes  Budget: ×1.10 = 11,312 bytes → 12 KB
    name: "All client CSS",
    path: [".next/static/**/*.css"],
    limit: "12 kB",
  },
];
