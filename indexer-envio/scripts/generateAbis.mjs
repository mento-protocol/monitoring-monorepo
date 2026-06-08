#!/usr/bin/env node
/**
 * generateAbis.mjs — refresh vendored ABIs from `@mento-protocol/contracts`.
 *
 * Why: Envio's config YAML reads `abi_file_path` as a literal filesystem path
 * at codegen time, so it can't follow `node_modules` import paths. We mirror
 * the upstream package's ABIs into `indexer-envio/abis/` and commit them, so
 * Envio Cloud builds stay reproducible without `node_modules`.
 *
 * Run manually after bumping `@mento-protocol/contracts` (similar cadence to
 * `pnpm generate:ntt-addresses`):
 *
 *   cd indexer-envio && pnpm generate:abis
 *
 * Then commit the diff.
 *
 * Scope: only ABIs that ship in `@mento-protocol/contracts/abis/`. The
 * following hand-curated ABIs are intentionally NOT managed by this script:
 *
 *   - abis/ERC20.json — minimal Transfer-only ABI; no upstream counterpart
 *   - abis/wormhole/NttDeployHelper.json — minimal getter-only subset of the
 *     full helper ABI (we only need `nttManagerProxy` + `transceiverProxy`)
 *   - abis/wormhole/NttManager.json — minimal subset for the indexer's needs
 *   - abis/wormhole/WormholeTransceiver.json — minimal subset
 *
 * Update those by hand if upstream Wormhole NTT events ever change.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const UPSTREAM_DIR = resolve(
  REPO,
  "node_modules/@mento-protocol/contracts/abis",
);
const VENDORED_DIR = resolve(REPO, "abis");
const LIQUITY_DIR = resolve(VENDORED_DIR, "liquity");

// Explicit allow-list. Add a new entry here when the indexer starts consuming
// another upstream ABI. The explicit list is intentional — it doubles as
// documentation and forces a code review when scope changes.
const ABIS = [
  "BreakerBox",
  "FPMM",
  "FPMMFactory",
  "MedianDeltaBreaker",
  "OpenLiquidityStrategy",
  "SortedOracles",
  "ValueDeltaBreaker",
  "VirtualPoolFactory",
];

const LIQUITY_ABIS = [
  "ActivePool",
  "AddressesRegistry",
  "BorrowerOperations",
  "CDPLiquidityStrategy",
  "CollateralRegistry",
  "DefaultPool",
  "FXPriceFeed",
  "ReserveTroveFactory",
  "StabilityPool",
  "SystemParams",
  "TroveManager",
  "TroveNFT",
];

let copied = 0;
let unchanged = 0;
const missing = [];

function copyAbi(name, targetDir = VENDORED_DIR) {
  const src = resolve(UPSTREAM_DIR, `${name}.json`);
  const dst = resolve(targetDir, `${name}.json`);

  let srcRaw;
  try {
    srcRaw = readFileSync(src, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      missing.push(name);
      return;
    }
    throw err;
  }

  // Round-trip through JSON.parse / JSON.stringify so the output is normalized
  // (2-space indent, trailing newline) regardless of upstream formatting.
  const parsed = JSON.parse(srcRaw);
  const dstRaw = JSON.stringify(parsed, null, 2) + "\n";

  let prev = null;
  try {
    prev = readFileSync(dst, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (prev === dstRaw) {
    console.log(`  unchanged  ${dst.replace(`${VENDORED_DIR}/`, "")}`);
    unchanged += 1;
  } else {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(dst, dstRaw);
    console.log(`  wrote      ${dst.replace(`${VENDORED_DIR}/`, "")}`);
    copied += 1;
  }
}

for (const name of ABIS) copyAbi(name);
for (const name of LIQUITY_ABIS) copyAbi(name, LIQUITY_DIR);

if (missing.length > 0) {
  console.error(
    `\n[generateAbis] missing upstream ABIs (run \`pnpm install\`?):\n  - ${missing.join("\n  - ")}\n`,
  );
  console.error(
    `Looked under: ${UPSTREAM_DIR}\n` +
      "If upstream renamed/removed an ABI, update the ABIS list in this script.",
  );
  process.exit(1);
}

console.log(
  `\n[generateAbis] ${copied} updated, ${unchanged} unchanged (${ABIS.length + LIQUITY_ABIS.length} total).`,
);
