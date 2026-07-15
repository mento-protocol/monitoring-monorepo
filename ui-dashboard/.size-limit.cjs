// Size budgets for the Next.js 16 (Turbopack) dashboard build output.
//
// WHY MANIFEST TARGETS (not entry points):
// Turbopack produces content-hashed filenames (e.g. `0xewy2a70rsnd.js`)
// that change on every build. @size-limit/preset-app / webpack-based presets
// can't bundle from entry points in App Router with Turbopack.
// @size-limit/file + concrete paths from Next's build manifests measures the
// actual bytes the browser downloads while ignoring orphaned content-hashed
// chunks left behind by repeated local builds.
//
// HOW TO UPDATE BUDGETS:
// 1. Run `pnpm dashboard:build` to get a fresh `.next/` output.
// 2. Run `pnpm --filter @mento-protocol/ui-dashboard exec size-limit --json`
//    to measure current sizes.
// 3. Set budget to current_bytes × 1.10 (10% headroom).
// 4. Update the comments below with the new baseline + date.
//
// BASELINE (measured 2026-07-15 with Next.js 16.2.6 + Turbopack):
//   All client JS chunks (brotli):     1,122,116 bytes (1.07 MB)
//   Plotly chunk (brotli):               288,930 bytes
//   Markdown editor chunk (brotli):       44,109 bytes
//   Sentry replay chunk (brotli):         34,792 bytes
//   All CSS (brotli):                     11,400 bytes (11.1 KB)

const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");

const DIST_DIR = ".next";
const STATIC_ASSET_RE =
  /(?:\/_next\/)?(static\/[^"'\\\s]+?\.(?:js|css))(?=["'\\\s,\]}])/g;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function isBuildManifest(file) {
  const basename = path.basename(file);

  return (
    basename.endsWith("manifest.json") ||
    basename.endsWith("_client-reference-manifest.js") ||
    basename === "middleware-build-manifest.js"
  );
}

function collectManifestReferencedStaticAssets({
  cwd = process.cwd(),
  distDir = DIST_DIR,
  extension,
  prefixes,
}) {
  const absoluteDistDir = path.resolve(cwd, distDir);
  const manifestFiles = listFiles(absoluteDistDir).filter(isBuildManifest);
  const assets = new Set();
  const queue = [];

  function addAsset(asset) {
    if (
      path.isAbsolute(asset) ||
      asset.split("/").includes("..") ||
      !asset.endsWith(extension) ||
      !prefixes.some((prefix) => asset.startsWith(prefix))
    ) {
      return;
    }

    const candidate = path.resolve(cwd, distDir, ...asset.split("/"));
    if (fs.existsSync(candidate) && !assets.has(asset)) {
      assets.add(asset);
      queue.push(asset);
    }
  }

  for (const manifestFile of manifestFiles) {
    const manifestText = fs.readFileSync(manifestFile, "utf8");

    for (const match of manifestText.matchAll(STATIC_ASSET_RE)) {
      const asset = match[1];

      if (asset !== undefined) addAsset(asset);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const asset = queue[index];
    if (asset === undefined) continue;

    const assetFile = path.resolve(cwd, distDir, ...asset.split("/"));
    const assetText = fs.readFileSync(assetFile, "utf8");

    for (const match of assetText.matchAll(STATIC_ASSET_RE)) {
      const referencedAsset = match[1];

      if (referencedAsset !== undefined) addAsset(referencedAsset);
    }
  }

  return [...assets].map((asset) => `${distDir}/${asset}`).sort();
}

function hasBuildManifests({ cwd = process.cwd(), distDir = DIST_DIR } = {}) {
  const absoluteDistDir = path.resolve(cwd, distDir);
  return listFiles(absoluteDistDir).some(isBuildManifest);
}

function manifestPathsOrFallback(extension, prefixes, fallbackGlob) {
  const paths = collectManifestReferencedStaticAssets({ extension, prefixes });
  if (paths.length > 0) return paths;

  if (hasBuildManifests()) {
    process.stderr.write(
      `[size-limit] warning: manifests found but no ${extension} assets extracted; falling back to ${fallbackGlob}\n`,
    );
  }

  return [fallbackGlob];
}

// Pin a single logical chunk by a stable content marker instead of a filename.
// Turbopack content-hashes filenames every build (see header), so a named budget
// can't key on the filename; we read each manifest-referenced JS asset and select
// the one whose source contains `marker`. This lets us guard individual chunks —
// the Plotly bundle and the lazy markdown-editor bundle — so a regression trips a
// tight per-chunk budget rather than hiding inside the aggregate. If a marker ever
// stops matching (renamed/removed), we return a non-existent sentinel path so
// size-limit reports 0 bytes and passes, leaving the aggregate budget as backstop
// rather than crashing the whole run on an empty path list.
function chunkContaining(marker, label) {
  const assets = collectManifestReferencedStaticAssets({
    extension: ".js",
    prefixes: ["static/chunks/"],
  });
  const cwd = process.cwd();
  const matches = assets.filter((asset) => {
    try {
      return fs.readFileSync(path.resolve(cwd, asset), "utf8").includes(marker);
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    return [`${DIST_DIR}/static/chunks/__no_${label}_chunk_matched__.js`];
  }

  if (matches.length > 1) {
    // Exactly one chunk is expected. A silent multi-match would make the budget
    // measure the SUM of several chunks — which could hide a regression if a
    // re-split scattered the code into individually-small chunks. Surface it so
    // the "one logical chunk" assumption can't break unnoticed.
    process.stderr.write(
      `[size-limit] warning: marker "${marker}" matched ${matches.length} chunks ` +
        `(${matches.map((asset) => path.basename(asset)).join(", ")}); the "${label}" ` +
        `budget now measures their combined size. Investigate a bundling/dedup change ` +
        `before trusting this budget.\n`,
    );
  }

  return matches;
}

/** @type {import('size-limit').SizeLimitConfig} */
const config = [
  {
    // All client-side JavaScript emitted by Turbopack under .next/static/chunks/.
    // This is what the browser downloads (brotli-compressed in prod via CDN).
    // Dominant contributor is Plotly, loaded lazily via @/lib/react-plotly-basic.
    //
    // The chart layer was accidentally shipping the FULL plotly.js build
    // (mapbox-gl + WebGL) because react-plotly.js defaults to it even though the
    // app declares plotly.js-basic-dist-min. Building the shared Plot via
    // react-plotly.js/factory + plotly.js-basic-dist-min (only scatter/bar/pie
    // traces are used) cut the client JS from 1,702,785 → 1,085,606 bytes brotli
    // (−36%). See docs/notes/ui-dashboard-performance-plan.md (P1).
    //
    // Baseline: 1,122,116 bytes  Budget: 1180 KB. Replacing graphql-request with
    // the internal fetch transport and moving client schemas to zod/mini removed
    // 11,888 bytes from the 1,134,004-byte baseline, so the aggregate cap tightens
    // by 10 KB rather than giving the savings back. (Was 1,085,606 after the P1
    // plotly swap; lazy-splitting the markdown editor in P4 moved ~44 KB brotli off
    // the data-page critical path but added ~9 KB of async chunk-boundary overhead
    // to this all-chunks total; lazy-loading Sentry Session Replay (2026-07-09)
    // moved ~29 KB brotli off every page's root chunks for ~6 KB of async
    // chunk-boundary overhead here — the per-chunk budgets below track the real
    // wins.) Keep this tight so a regression back to the full plotly.js build
    // fails CI.
    name: "All client JS chunks",
    path: manifestPathsOrFallback(
      ".js",
      ["static/chunks/"],
      ".next/static/chunks/**/*.js",
    ),
    limit: "1180 kB",
  },
  {
    // Plotly chunk, pinned by content (the "js-plotly-plot" DOM class the bundle
    // emits) so it survives Turbopack's per-build content hashing. Guards P1: the
    // lean plotly.js-basic-dist-min build is ~291 KB brotli; reintroducing the full
    // plotly.js (mapbox-gl + WebGL) balloons this chunk past the budget and fails CI
    // here, before it hides inside the 1180 KB aggregate.
    //
    // Baseline: 288,930 bytes  Budget: ×1.10 = 317,823 bytes → 320 KB
    name: "Plotly chunk (js-plotly-plot)",
    path: chunkContaining("js-plotly-plot", "plotly"),
    limit: "320 kB",
  },
  {
    // Markdown-editor chunk, pinned by the "react-markdown" marker. Guards P4: the
    // react-markdown + remark-gfm + rehype-sanitize pipeline is lazy-loaded via
    // next/dynamic from address-link.tsx, so it lives in its own ~44 KB brotli async
    // chunk instead of shipping on every page that renders an AddressLink. If a
    // static import re-merges it into a shared chunk, the matched chunk's size jumps
    // well past this budget and fails CI.
    //
    // Baseline: 44,109 bytes  Budget: ×1.10 = 48,520 bytes → 49 KB
    name: "Markdown editor chunk (react-markdown)",
    path: chunkContaining("react-markdown", "markdown"),
    limit: "49 kB",
  },
  {
    // Sentry Session Replay chunk, pinned by the rrweb "rr_width" attribute the
    // recorder emits. Guards the replay lazy-load: replayIntegration() is added
    // after Sentry.init via a dynamic import of @/lib/sentry-replay (see
    // src/instrumentation-client.ts), so the rrweb recorder lives in its own
    // ~35 KB brotli idle-loaded async chunk instead of every page's root chunks.
    // If a static import (or a barrel-wide dynamic import) re-merges it into a
    // shared chunk, the matched chunk's size jumps well past this budget and
    // fails CI.
    //
    // Baseline: 34,792 bytes  Budget: ×1.10 = 38,271 bytes → 39 KB
    name: "Sentry replay chunk (rr_width)",
    path: chunkContaining("rr_width", "sentry-replay"),
    limit: "39 kB",
  },
  {
    // Manifest-referenced CSS emitted under .next/static/ (single Tailwind v4 bundle).
    //
    // Baseline: 11,400 bytes  Budget: retained at 12 KB (5.3% headroom)
    name: "All client CSS",
    path: manifestPathsOrFallback(".css", ["static/"], ".next/static/**/*.css"),
    limit: "12 kB",
  },
];

Object.defineProperty(config, "_private", {
  value: {
    collectManifestReferencedStaticAssets,
    manifestPathsOrFallback,
    chunkContaining,
  },
});

module.exports = config;
