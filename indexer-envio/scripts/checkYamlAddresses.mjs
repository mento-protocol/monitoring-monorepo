#!/usr/bin/env node
/**
 * checkYamlAddresses.mjs — drift gate for Envio multichain config YAMLs.
 *
 * Why: Envio's CLI reads `config.multichain.*.yaml` literally — no JSON
 * imports at config-load time. So every contract address is duplicated
 * out of `@mento-protocol/contracts`. The package upstream silently
 * republishes addresses (StabilityPool proxy/impl rename in 0.8.1 was one
 * recent example), and these YAMLs drift unnoticed until indexing breaks.
 *
 * What this checks: every hex address under an `address:` key in the YAML
 * must be one of
 *   1. published in `@mento-protocol/contracts/contracts.json` (any chain/ns)
 *   2. derived in `indexer-envio/config/nttAddresses.json` (NTT manager /
 *      transceiver proxies — CREATE-deterministic helpers, not in the package)
 *   3. on the inline ALLOWLIST below (hand-managed instances + external
 *      contracts like Wormhole core / aggregators)
 *
 * Anything else fails with a clear pointer.
 *
 * When to re-run: pre-codegen + CI. Exits 0 on clean, 1 on drift.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const CONTRACTS_JSON = resolve(
  REPO,
  "node_modules/@mento-protocol/contracts/contracts.json",
);
const NTT_JSON = resolve(REPO, "config/nttAddresses.json");

// Addresses intentionally NOT in `@mento-protocol/contracts` because they
// aren't part of the protocol package (factory-deployed pool instances on
// testnet, third-party infrastructure). Add new entries here with a reason
// when wiring a new external contract into a YAML.
const ALLOWLIST = new Map([
  // Testnet FPMM pool instances. Mainnet uses dynamic registration via
  // `FPMMFactory.FPMMDeployed.contractRegister`; testnet hand-lists them.
  ["0x550d9ecb4c373510b8a41f5fb7d98e9e1c51a07e", "FPMM:GBPm/USDm (testnet)"],
  ["0xd9e9e6f6b5298e8bad390f7748035c49d6eeb055", "FPMM testnet instance"],
  ["0x1229e8a7b266c6db52712ba5c6899a6c4c3025cd", "FPMM testnet instance"],
  ["0x671334256a893fdbc4ffe55f98f156a168bd897a", "FPMM testnet instance"],
  ["0x1e2506edca4ef3030e51be8b571b935d55677604", "FPMM testnet instance"],
  ["0x8103fb2db87ac96cc62faa399b98e1173720ab19", "FPMM testnet instance"],
  ["0x62722497dc8992337117ee79a02015dcea43b2c2", "FPMM testnet instance"],
  ["0x68d19b5a48cbbfd11057e97da9960b09d771e7b6", "FPMM testnet instance"],
  ["0x58f08739ea9764097b9500b6e4a4db64d168b807", "FPMM testnet instance"],
  ["0x284c2d99c5a12a65f10eff7183c33c1217b65a56", "FPMM testnet instance"],
  ["0xcbfc8c84168d7f34faba0018a3a63b998f1ffece", "FPMM testnet instance"],
  ["0x49a968c539599385c69c2d528500da58d933fafa", "FPMM testnet instance"],
  ["0x917ee035bf0a964acc75539f919a5b4f16336373", "FPMM testnet instance"],
  ["0x6b66271811615f4b6dadb8620ed71a1e90f41deb", "FPMM testnet instance"],
  ["0x22118009665b1d6810d4560a098d3e67bbcb934f", "FPMM testnet instance"],
  ["0x6d4c4b663541bf21015afb22669b0e1bbb3e2b1c", "FPMM testnet instance"],
]);

// ───────────────────────────────────────────────────────────────────────────

function buildKnownSet() {
  const known = new Set();

  // contracts.json: chains → namespaces → keys → { address, ... }
  const contracts = JSON.parse(readFileSync(CONTRACTS_JSON, "utf8"));
  for (const namespaces of Object.values(contracts)) {
    for (const entries of Object.values(namespaces)) {
      for (const entry of Object.values(entries)) {
        if (entry && typeof entry === "object" && "address" in entry) {
          known.add(entry.address.toLowerCase());
        }
      }
    }
  }

  // nttAddresses.json: { entries: [{ tokenAddress, helper, nttManagerProxy, transceiverProxy }] }
  const ntt = JSON.parse(readFileSync(NTT_JSON, "utf8"));
  for (const e of ntt.entries ?? []) {
    for (const field of [
      "tokenAddress",
      "helper",
      "nttManagerProxy",
      "transceiverProxy",
    ]) {
      if (e[field]) known.add(e[field].toLowerCase());
    }
  }

  // Allowlist
  for (const addr of ALLOWLIST.keys()) {
    known.add(addr);
  }

  return known;
}

function findYamlFiles() {
  return readdirSync(REPO)
    .filter((f) => /^config(\.multichain\.[a-z0-9-]+)?\.yaml$/.test(f))
    .map((f) => join(REPO, f));
}

// Match `  - 0xABCDEF...` or `  - "0xABCDEF..."` inside an address: block.
// Captures line number + raw address per occurrence.
function extractAddresses(yamlSource) {
  const out = [];
  let inAddressBlock = false;
  let blockIndent = -1;
  const lines = yamlSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/#.*$/, "").trimEnd();
    // Detect entry into an `address:` block (list form). Inline `address: []`
    // doesn't open a block; `address: [ "0x.." ]` we handle inline below.
    const blockOpen = line.match(/^(\s*)address:\s*$/);
    if (blockOpen) {
      inAddressBlock = true;
      blockIndent = blockOpen[1].length;
      continue;
    }
    // Inline form: `address: [ 0x..., 0x... ]` or `address: ['0x..']`
    const inline = line.match(/^\s*address:\s*\[(.*)\]/);
    if (inline) {
      const matches = inline[1].matchAll(/0x[a-fA-F0-9]{40}/g);
      for (const m of matches) out.push({ line: i + 1, addr: m[0] });
      continue;
    }
    if (!inAddressBlock) continue;
    // Inside a list block: lines like `          - 0xABC...` with comments.
    // Exit the block when indent decreases below the address: key indent.
    const leadingWs = line.match(/^(\s*)/)[1].length;
    if (trimmed === "" || leadingWs <= blockIndent) {
      if (trimmed === "") continue;
      inAddressBlock = false;
      // Fall through to re-process this line normally (e.g. next key).
      i--;
      continue;
    }
    const item = line.match(/^\s*-\s*"?(0x[a-fA-F0-9]{40})"?/);
    if (item) out.push({ line: i + 1, addr: item[1] });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────

const known = buildKnownSet();
const yamls = findYamlFiles();
if (yamls.length === 0) {
  console.error("No YAML files matched config(.multichain.*)?.yaml in", REPO);
  process.exit(2);
}

let drift = 0;
let total = 0;
for (const path of yamls) {
  const rel = path.slice(REPO.length + 1);
  const src = readFileSync(path, "utf8");
  const found = extractAddresses(src);
  for (const { line, addr } of found) {
    total++;
    if (!known.has(addr.toLowerCase())) {
      drift++;
      console.error(
        `✖ ${rel}:${line}  ${addr} not in @mento-protocol/contracts, nttAddresses.json, or the ALLOWLIST.`,
      );
    }
  }
}

if (drift > 0) {
  console.error(
    `\n${drift} unknown address${drift === 1 ? "" : "es"} of ${total} checked.\n` +
      `Fix one of:\n` +
      `  • Bump @mento-protocol/contracts so the address is published.\n` +
      `  • Regenerate config/nttAddresses.json if it's a new NTT proxy.\n` +
      `  • Add it to the ALLOWLIST in scripts/checkYamlAddresses.mjs with a reason.`,
  );
  process.exit(1);
}

console.log(
  `✓ ${total} YAML addresses across ${yamls.length} file${yamls.length === 1 ? "" : "s"} all resolve to a known source.`,
);
