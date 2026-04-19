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

const contractsJson = JSON.parse(
  readFileSync(
    resolve(REPO, "node_modules/@mento-protocol/contracts/contracts.json"),
    "utf8",
  ),
);
const namespaces = JSON.parse(
  readFileSync(resolve(REPO, "config/deployment-namespaces.json"), "utf8"),
);

// Wormhole chain ID per EVM chain ID. Extend when adding new chains.
// See https://docs.wormhole.com/wormhole/reference/constants
const WORMHOLE_CHAIN_ID = {
  42220: 14, // Celo
  143: 48, // Monad
  // 137: 5,   // Polygon (future)
};

const HELPER_PREFIX = "NttDeployHelper"; // "NttDeployHelperUSDm" etc.

/** Extract `{USDm|GBPm|EURm|...}` from a helper entry name. */
function symbolFromHelperName(name) {
  return name.slice(HELPER_PREFIX.length);
}

const output = { $generated: true, entries: [] };

for (const [chainIdStr, ns] of Object.entries(namespaces)) {
  const chainId = Number(chainIdStr);
  const entries = contractsJson[chainIdStr]?.[ns];
  if (!entries) continue;

  const wormholeChainId = WORMHOLE_CHAIN_ID[chainId];
  if (wormholeChainId === undefined) {
    console.warn(
      `[generateNttAddresses] no Wormhole chain id mapped for EVM chain ${chainId} — skipping`,
    );
    continue;
  }

  for (const [name, info] of Object.entries(entries)) {
    if (!name.startsWith(HELPER_PREFIX)) continue;
    if (info.type !== "contract" || !info.address) continue;

    const symbol = symbolFromHelperName(name);
    const tokenEntry = entries[symbol] ?? entries[`${symbol}Spoke`];
    if (!tokenEntry) {
      console.warn(
        `[generateNttAddresses] no token entry for ${symbol} on chain ${chainId} — skipping`,
      );
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

console.log(
  "\nPaste these into config.multichain.mainnet.yaml under each network's contracts:",
);
const byChain = {};
for (const e of output.entries) {
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
