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
 * What this checks: every hex address under an `address:` key in a
 * `chains[].id` section must be known **for that chain**. Sources:
 *   1. `@mento-protocol/contracts/contracts.json` — chain → namespace → key
 *   2. `indexer-envio/config/nttAddresses.json` — chain → NTT proxies
 *   3. The inline `ALLOWLIST` below (hand-managed instances + external
 *      contracts like Wormhole core / aggregators)
 *
 * Validation is per-chain on purpose — a typo that swaps a Celo address for
 * a Monad one would pass a flat global check but still wire the indexer to
 * the wrong contract. Anything else fails with a clear file:line pointer.
 *
 * When to re-run: pre-codegen + CI. Exits 0 on clean, 1 on drift.
 */

import { readFileSync, readdirSync, lstatSync } from "node:fs";
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
// testnet, third-party infrastructure). Keyed by lowercased address with the
// chain it belongs on — same address on a different chain doesn't get a
// free pass. Add new entries with a reason when wiring a new external
// contract into a YAML.
const ALLOWLIST = new Map([
  // Testnet FPMM pool instances. Mainnet uses dynamic registration via
  // `FPMMFactory.FPMMDeployed.contractRegister`; testnet hand-lists them.
  [
    "0x550d9ecb4c373510b8a41f5fb7d98e9e1c51a07e",
    { chainId: 11142220, reason: "FPMM:GBPm/USDm (testnet)" },
  ],
  [
    "0x671334256a893fdbc4ffe55f98f156a168bd897a",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x1e2506edca4ef3030e51be8b571b935d55677604",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x8103fb2db87ac96cc62faa399b98e1173720ab19",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x62722497dc8992337117ee79a02015dcea43b2c2",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x68d19b5a48cbbfd11057e97da9960b09d771e7b6",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x58f08739ea9764097b9500b6e4a4db64d168b807",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x284c2d99c5a12a65f10eff7183c33c1217b65a56",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0xcbfc8c84168d7f34faba0018a3a63b998f1ffece",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x49a968c539599385c69c2d528500da58d933fafa",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x917ee035bf0a964acc75539f919a5b4f16336373",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x6b66271811615f4b6dadb8620ed71a1e90f41deb",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0x22118009665b1d6810d4560a098d3e67bbcb934f",
    { chainId: 11142220, reason: "FPMM testnet instance" },
  ],
  [
    "0xd9e9e6f6b5298e8bad390f7748035c49d6eeb055",
    { chainId: 10143, reason: "FPMM testnet instance" },
  ],
  [
    "0x1229e8a7b266c6db52712ba5c6899a6c4c3025cd",
    { chainId: 10143, reason: "FPMM testnet instance" },
  ],
  [
    "0x6d4c4b663541bf21015afb22669b0e1bbb3e2b1c",
    { chainId: 10143, reason: "FPMM testnet instance" },
  ],
]);

// ───────────────────────────────────────────────────────────────────────────

// Returns Map<chainIdString, Set<lowercaseAddress>>.
// Assumes contracts.json is shaped exactly `chains → namespaces → keys →
// { address, ... }`. If the upstream package ever introduces a fourth
// nesting level (e.g. versioned contract groups), addresses in sub-objects
// would be silently dropped and produce false-positive drift failures here.
// Update this loop if that shape changes.
function buildKnownByChain() {
  const byChain = new Map();
  const ensure = (chainId) => {
    const key = String(chainId);
    let s = byChain.get(key);
    if (!s) {
      s = new Set();
      byChain.set(key, s);
    }
    return s;
  };

  const contracts = JSON.parse(readFileSync(CONTRACTS_JSON, "utf8"));
  for (const [chainId, namespaces] of Object.entries(contracts)) {
    const set = ensure(chainId);
    for (const entries of Object.values(namespaces)) {
      for (const entry of Object.values(entries)) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.address === "string"
        ) {
          set.add(entry.address.toLowerCase());
        }
      }
    }
  }

  const ntt = JSON.parse(readFileSync(NTT_JSON, "utf8"));
  for (const e of ntt.entries ?? []) {
    if (e.chainId == null) continue;
    const set = ensure(e.chainId);
    for (const field of [
      "tokenAddress",
      "helper",
      "nttManagerProxy",
      "transceiverProxy",
    ]) {
      if (e[field]) set.add(e[field].toLowerCase());
    }
  }

  for (const [addr, meta] of ALLOWLIST) {
    ensure(meta.chainId).add(addr.toLowerCase());
  }

  return byChain;
}

function findYamlFiles() {
  return readdirSync(REPO)
    .filter((f) => /^config(\.multichain\.[a-z0-9-]+)?\.yaml$/.test(f))
    .map((f) => join(REPO, f))
    .filter((p) => !lstatSync(p).isSymbolicLink());
}

// Walks the YAML line-by-line tracking three pieces of state:
//   1. `currentChain` — the chainId of the most recent `chains[].id` entry.
//      Addresses outside any `chains:` block (e.g. under the top-level
//      `contracts:` schema list) are emitted with chain=null so they fail
//      validation visibly instead of being silently accepted.
//   2. `inAddressBlock` / `blockIndent` — whether we're inside a list-form
//      `address:` block, used to scope the per-item matcher.
//   3. Each list item is required to be a complete `0x[hex]{40}` literal
//      (un-, single-, or double-quoted). Malformed items inside an
//      `address:` block fail loud — silently skipping them would let a
//      typo like `0xdeadbe` slip past the gate.
function extractAddresses(yamlSource) {
  const out = [];
  let currentChain = null;
  let inAddressBlock = false;
  let blockIndent = -1;
  let inChainsBlock = false;
  let chainsBlockIndent = -1;
  const lines = yamlSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/#.*$/, "").trimEnd();
    const leadingWs = line.match(/^(\s*)/)[1].length;

    // Track chains: block entry/exit. Top-level `chains:` opens it; any
    // line at column 0 that's a different top-level key closes it.
    if (/^chains:\s*$/.test(line)) {
      inChainsBlock = true;
      chainsBlockIndent = 0;
      continue;
    }
    if (
      inChainsBlock &&
      trimmed !== "" &&
      leadingWs <= chainsBlockIndent &&
      !/^\s/.test(line)
    ) {
      inChainsBlock = false;
      currentChain = null;
    }

    // Network entry under chains: `  - id: <N>`
    if (inChainsBlock) {
      const idMatch = line.match(/^\s+-\s+id:\s*(\d+)/);
      if (idMatch) currentChain = idMatch[1];
    }

    // List-form `address:` block opener.
    const blockOpen = line.match(/^(\s*)address:\s*$/);
    if (blockOpen) {
      inAddressBlock = true;
      blockIndent = blockOpen[1].length;
      continue;
    }

    // Inline-form `address: [ 0x..., 0x.. ]`. Accepts un-, single-, and
    // double-quoted entries.
    const inline = line.match(/^\s*address:\s*\[(.*)\]/);
    if (inline) {
      const matches = inline[1].matchAll(/['"]?(0x[a-fA-F0-9]{40})['"]?/g);
      for (const m of matches) {
        out.push({ line: i + 1, addr: m[1], chainId: currentChain });
      }
      continue;
    }

    if (!inAddressBlock) continue;

    // Block-form list item — exit the block when indent drops back to the
    // address: key level or below.
    if (trimmed === "" || leadingWs <= blockIndent) {
      if (trimmed === "") continue;
      inAddressBlock = false;
      i--; // re-process this line at the outer level
      continue;
    }
    // Anything inside an address: block must be a `- 0x[hex]{40}` (un-,
    // single-, or double-quoted). Treat anything else as malformed — fail
    // loud instead of silently skipping a typo. Use the comment-stripped
    // `trimmed` so trailing `# label` comments don't break value parsing.
    const item = trimmed.match(/^\s*-\s*(.*?)\s*$/);
    if (!item) continue; // shouldn't happen given the indent check above
    const value = item[1].replace(/^['"]|['"]$/g, "");
    const valid = value.match(/^0x[a-fA-F0-9]{40}$/);
    if (valid) {
      out.push({ line: i + 1, addr: valid[0], chainId: currentChain });
    } else {
      out.push({
        line: i + 1,
        addr: value,
        chainId: currentChain,
        malformed: true,
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────

const byChain = buildKnownByChain();
const yamls = findYamlFiles();
if (yamls.length === 0) {
  console.error("No YAML files matched config(.multichain.*)?.yaml in", REPO);
  process.exit(2);
}

let drift = 0;
let total = 0;
for (const filePath of yamls) {
  const rel = filePath.slice(REPO.length + 1);
  const src = readFileSync(filePath, "utf8");
  const found = extractAddresses(src);
  for (const item of found) {
    total++;
    const { line, addr, chainId, malformed } = item;
    if (malformed) {
      drift++;
      console.error(
        `✖ ${rel}:${line}  "${addr}" inside an address: block is not a valid 0x[hex]{40} address.`,
      );
      continue;
    }
    if (chainId == null) {
      drift++;
      console.error(
        `✖ ${rel}:${line}  ${addr} is outside any chains[].id section — cannot validate per-chain.`,
      );
      continue;
    }
    const set = byChain.get(chainId);
    if (!set || !set.has(addr.toLowerCase())) {
      drift++;
      console.error(
        `✖ ${rel}:${line}  ${addr} not registered for chain ${chainId} in @mento-protocol/contracts, nttAddresses.json, or the ALLOWLIST.`,
      );
    }
  }
}

if (drift > 0) {
  console.error(
    `\n${drift} unknown address${drift === 1 ? "" : "es"} of ${total} checked.\n` +
      `Fix one of:\n` +
      `  • Bump @mento-protocol/contracts so the address is published for this chain.\n` +
      `  • Regenerate config/nttAddresses.json if it's a new NTT proxy.\n` +
      `  • Add it to the ALLOWLIST in scripts/checkYamlAddresses.mjs with chainId + reason.`,
  );
  process.exit(1);
}

console.log(
  `✓ ${total} YAML addresses across ${yamls.length} file${yamls.length === 1 ? "" : "s"} all resolve to a known source for their chain.`,
);
