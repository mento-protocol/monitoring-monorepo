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
// BASELINE (measured 2026-05-18 with Next.js 16.2.6 + Turbopack):
//   All client JS chunks (brotli): 1,702,785 bytes (1.62 MB)
//   All CSS (brotli):              10,283 bytes (10.0 KB)

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

function manifestPathsOrFallback(extension, prefixes, fallbackGlob) {
  const paths = collectManifestReferencedStaticAssets({ extension, prefixes });
  return paths.length > 0 ? paths : [fallbackGlob];
}

/** @type {import('size-limit').SizeLimitConfig} */
const config = [
  {
    // All client-side JavaScript emitted by Turbopack under .next/static/chunks/.
    // This is what the browser downloads (brotli-compressed in prod via CDN).
    // Dominant contributor is plotly.js-basic-dist-min (~1.3 MB brotli).
    //
    // Baseline: 1,702,785 bytes  Budget: ×1.10 = 1,873,064 bytes → 1830 KB
    // PR #624 (oracle chart breaker-band rewrite, 2026-05-27): the chart's
    // wheel handler, breaker-config plumbing, and new hover formatter add
    // ~3 KB brotli. Bumped to 1850 KB (~1.4% headroom over current) so the
    // feature ships without bumping the absolute budget unreasonably.
    name: "All client JS chunks",
    path: manifestPathsOrFallback(
      ".js",
      ["static/chunks/"],
      ".next/static/chunks/**/*.js",
    ),
    limit: "1850 kB",
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
  value: { collectManifestReferencedStaticAssets },
});

module.exports = config;
