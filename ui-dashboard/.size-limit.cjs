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
// BASELINE (measured 2026-07-06 with Next.js 16.2.6 + Turbopack):
//   All client JS chunks (brotli):     1,094,742 bytes (1.04 MB)
//   Plotly chunk (brotli):               291,466 bytes
//   Markdown editor chunk (brotli):       44,130 bytes
//   All CSS (brotli):                     10,987 bytes (10.7 KB)

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
    // Baseline: 1,094,742 bytes  Budget: 1190 KB. (Was 1,085,606 after the P1
    // plotly swap; lazy-splitting the markdown editor in P4 moved ~44 KB brotli off
    // the data-page critical path but added ~9 KB of async chunk-boundary overhead
    // to this all-chunks total — the per-chunk budgets below track the real wins.)
    // Keep this tight so a regression back to the full plotly.js build fails CI.
    name: "All client JS chunks",
    path: manifestPathsOrFallback(
      ".js",
      ["static/chunks/"],
      ".next/static/chunks/**/*.js",
    ),
    limit: "1190 kB",
  },
  {
    // Plotly chunk, pinned by content (the "js-plotly-plot" DOM class the bundle
    // emits) so it survives Turbopack's per-build content hashing. Guards P1: the
    // lean plotly.js-basic-dist-min build is ~291 KB brotli; reintroducing the full
    // plotly.js (mapbox-gl + WebGL) balloons this chunk past the budget and fails CI
    // here, before it hides inside the 1190 KB aggregate.
    //
    // Baseline: 291,466 bytes  Budget: ×1.10 = 320,613 bytes → 320 KB
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
    // Baseline: 44,130 bytes  Budget: ×1.10 = 48,543 bytes → 49 KB
    name: "Markdown editor chunk (react-markdown)",
    path: chunkContaining("react-markdown", "markdown"),
    limit: "49 kB",
  },
  {
    // Manifest-referenced CSS emitted under .next/static/ (single Tailwind v4 bundle).
    //
    // Baseline: 10,283 bytes  Budget: ×1.10 = 11,312 bytes → 12 KB
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
