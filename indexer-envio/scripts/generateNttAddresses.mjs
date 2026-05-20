#!/usr/bin/env node
/**
 * generateNttAddresses.mjs — build-time derivation of NttManager + WormholeTransceiver proxy addresses.
 *
 * Why: NttDeployHelper emits no events, so we cannot discover proxies via Envio's
 * contractRegister factory pattern. Helpers deploy proxies sequentially from a fresh
 * account, so `CREATE(helper, nonce)` is deterministic and computable offline.
 *
 * Inputs:
 *   - @mento-protocol/contracts/contracts.json (helper addresses)
 *   - indexer-envio/config/deployment-namespaces.json (chainId → namespace)
 *
 * Output: indexer-envio/config/nttAddresses.json — commit-tracked, consumed by
 * both the YAML (addresses pasted in manually) and the indexer runtime (for
 * resolving tokenSymbol/decimals from a manager address).
 *
 * When to re-run: after bumping @mento-protocol/contracts to a version that
 * ships new NttDeployHelper entries (new bridged token or new chain).
 *
 * Nonce layout inside NttDeployHelper constructor:
 *   nonce 1 → NttManager implementation
 *   nonce 2 → NttManager ERC1967Proxy         ← we use this
 *   nonce 3 → WormholeTransceiver implementation
 *   nonce 4 → WormholeTransceiver ERC1967Proxy ← we use this
 */

import { getContractAddress } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

// Wormhole chain ID per EVM chain ID. Extend when adding new chains.
// See https://docs.wormhole.com/wormhole/reference/constants
const WORMHOLE_CHAIN_ID = {
  42220: 14, // Celo
  143: 48, // Monad
  // 137: 5,   // Polygon (future)
};

const HELPER_PREFIX = "NttDeployHelper"; // "NttDeployHelperUSDm" etc.

// Known intentional gaps in the contracts manifest. Keep empty by default so
// newly partial NTT manifests fail closed.
const ALLOWED_MISSING_MANIFEST_GAPS = new Set([
  // Testnet manifests include bridge helper entries, but Wormhole testnet
  // chain IDs are not part of the committed mainnet NTT address config.
  "wormhole-chain-id:10143",
  "wormhole-chain-id:11142220",
]);

/** Extract `{USDm|GBPm|EURm|...}` from a helper entry name. */
export function symbolFromHelperName(name) {
  return name.slice(HELPER_PREFIX.length);
}

function gapKey(gap) {
  if (gap.kind === "wormhole-chain-id") {
    return `wormhole-chain-id:${gap.chainId}`;
  }
  return `token-entry:${gap.chainId}:${gap.tokenSymbol}`;
}

function isAllowedGap(gap, allowedGaps) {
  return allowedGaps.has(gapKey(gap));
}

function formatGap(gap) {
  if (gap.kind === "wormhole-chain-id") {
    return `missing Wormhole chain id for EVM chain ${gap.chainId} (${gap.namespace})`;
  }
  return `missing token entry for ${gap.tokenSymbol} on chain ${gap.chainId} (${gap.namespace})`;
}

export function generateNttAddressManifest({
  contractsJson,
  namespaces,
  wormholeChainIds = WORMHOLE_CHAIN_ID,
  allowedMissingManifestGaps = ALLOWED_MISSING_MANIFEST_GAPS,
}) {
  const output = { $generated: true, entries: [] };
  const failures = [];
  const skipped = [];

  for (const [chainIdStr, ns] of Object.entries(namespaces)) {
    const chainId = Number(chainIdStr);
    const entries = contractsJson[chainIdStr]?.[ns];
    if (!entries) continue;

    const wormholeChainId = wormholeChainIds[chainId];
    if (wormholeChainId === undefined) {
      const gap = {
        kind: "wormhole-chain-id",
        chainId,
        namespace: ns,
      };
      if (isAllowedGap(gap, allowedMissingManifestGaps)) {
        skipped.push(gap);
        continue;
      }
      failures.push(gap);
      continue;
    }

    for (const [name, info] of Object.entries(entries)) {
      if (!name.startsWith(HELPER_PREFIX)) continue;
      if (info.type !== "contract" || !info.address) continue;

      const symbol = symbolFromHelperName(name);
      const tokenEntry = entries[symbol] ?? entries[`${symbol}Spoke`];
      if (!tokenEntry) {
        const gap = {
          kind: "token-entry",
          chainId,
          namespace: ns,
          tokenSymbol: symbol,
        };
        if (isAllowedGap(gap, allowedMissingManifestGaps)) {
          skipped.push(gap);
          continue;
        }
        failures.push(gap);
        continue;
      }

      const helper = info.address;
      const nttManagerProxy = getContractAddress({ from: helper, nonce: 2n });
      const transceiverProxy = getContractAddress({ from: helper, nonce: 4n });

      output.entries.push({
        chainId,
        wormholeChainId,
        tokenSymbol: symbol,
        tokenAddress: tokenEntry.address.toLowerCase(),
        tokenDecimals: tokenEntry.decimals ?? 18,
        helper: helper.toLowerCase(),
        nttManagerProxy: nttManagerProxy.toLowerCase(),
        transceiverProxy: transceiverProxy.toLowerCase(),
      });
    }
  }

  output.entries.sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.tokenSymbol.localeCompare(b.tokenSymbol);
  });

  return { output, failures, skipped };
}

function readDefaultInputs() {
  return {
    contractsJson: JSON.parse(
      readFileSync(
        resolve(REPO, "node_modules/@mento-protocol/contracts/contracts.json"),
        "utf8",
      ),
    ),
    namespaces: JSON.parse(
      readFileSync(resolve(REPO, "config/deployment-namespaces.json"), "utf8"),
    ),
  };
}

function printYamlSnippet(entries) {
  console.log(
    "\nPaste these into config.multichain.mainnet.yaml under each network's contracts:",
  );
  const byChain = {};
  for (const e of entries) {
    byChain[e.chainId] = byChain[e.chainId] ?? [];
    byChain[e.chainId].push(e);
  }
  for (const [chainId, list] of Object.entries(byChain)) {
    console.log(`\n  # chain ${chainId}`);
    console.log("  - name: WormholeNttManager");
    console.log("    address:");
    for (const e of list)
      console.log(`      - ${e.nttManagerProxy} # ${e.tokenSymbol}`);
    console.log("  - name: WormholeTransceiver");
    console.log("    address:");
    for (const e of list)
      console.log(`      - ${e.transceiverProxy} # ${e.tokenSymbol}`);
  }
}

export function main() {
  const { output, failures, skipped } =
    generateNttAddressManifest(readDefaultInputs());

  for (const gap of skipped) {
    console.warn(`[generateNttAddresses] allow-listed ${formatGap(gap)}`);
  }

  if (failures.length > 0) {
    console.error("[generateNttAddresses] manifest is incomplete:");
    for (const gap of failures) {
      console.error(`  - ${formatGap(gap)}`);
    }
    console.error(
      "[generateNttAddresses] refusing to write partial config/nttAddresses.json",
    );
    process.exitCode = 1;
    return;
  }

  const outPath = resolve(REPO, "config/nttAddresses.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

  console.log(
    `[generateNttAddresses] wrote ${output.entries.length} entries to ${outPath}`,
  );
  for (const e of output.entries) {
    console.log(
      `  chain=${e.chainId} ${e.tokenSymbol.padEnd(6)} helper=${e.helper} manager=${e.nttManagerProxy} transceiver=${e.transceiverProxy}`,
    );
  }

  printYamlSnippet(output.entries);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
