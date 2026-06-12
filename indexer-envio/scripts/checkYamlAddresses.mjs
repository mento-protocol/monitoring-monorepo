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
 * What this checks: every hex address under an `address:` key inside a
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
 * Uses `yaml@2` for parsing so every YAML form (scalar / list / inline-flow
 * / multi-line-flow / quoted / with-trailing-comments) is handled by the
 * parser instead of a regex. Source positions come from the AST's
 * `range[0]` byte offsets — we keep one line-index per file to map those
 * back to line numbers for error output.
 *
 * When to re-run: pre-codegen + CI. Exits 0 on clean, 1 on drift.
 */

import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

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
  [
    "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
    { chainId: 1, reason: "Sky sUSDS token for reserve-yield accounting" },
  ],
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
  // V3 hub USDm collateral — distinct on-chain contract from Celo cUSD-USDm.
  // Address constant lives at src/constants.ts:V3_HUB_USDM_ADDRESS (imported
  // by handlers/liquity/config.ts AND handlers/stables/config.ts) — kept
  // duplicated here because this script is .mjs and can't import .ts. If
  // the value below ever drifts from constants.ts, the test
  // test/stables.test.ts:YAML drift gate fails. Remove this entry once
  // `@mento-protocol/contracts` republishes USDm at the V3 hub address.
  [
    "0x106cc9ff5a2c488780635be8afc07c68522b7ea5",
    {
      chainId: 42220,
      reason: "V3 hub USDm — hand-typed, not in @mento-protocol/contracts",
    },
  ],
]);

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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

// Convert a byte offset (from yaml AST node.range) into a 1-based line
// number for error output. Precompute newline positions once per file.
function lineLookupFor(source) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (offset) => {
    // binary search
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Walk every `address:` value found inside any `chains[].id` block. Emits
// one entry per address candidate, including malformed ones (so the caller
// can fail loud instead of silently skipping a typo).
function* extractAddresses(doc, src, lineOf) {
  const top = doc.contents;
  if (!isMap(top)) return;
  const chainsPair = top.items.find(
    (p) => isScalar(p.key) && p.key.value === "chains",
  );
  if (!chainsPair || !isSeq(chainsPair.value)) return;

  for (const chainNode of chainsPair.value.items) {
    if (!isMap(chainNode)) continue;
    const idPair = chainNode.items.find(
      (p) => isScalar(p.key) && p.key.value === "id",
    );
    const chainId =
      idPair && isScalar(idPair.value) ? String(idPair.value.value) : null;

    const contractsPair = chainNode.items.find(
      (p) => isScalar(p.key) && p.key.value === "contracts",
    );
    if (!contractsPair || !isSeq(contractsPair.value)) continue;

    for (const contractNode of contractsPair.value.items) {
      if (!isMap(contractNode)) continue;
      const addressPair = contractNode.items.find(
        (p) => isScalar(p.key) && p.key.value === "address",
      );
      if (!addressPair) continue;
      yield* addressItems(addressPair.value, chainId, lineOf, src);
    }
  }
}

function* addressItems(value, chainId, lineOf, src) {
  if (value == null) return;
  if (isScalar(value)) {
    if (value.value == null) return; // `address:` with empty value
    yield buildItem(scalarSource(value, src), chainId, lineOf, value);
    return;
  }
  if (isSeq(value)) {
    for (const item of value.items) {
      if (item == null) continue;
      if (isScalar(item)) {
        if (item.value == null) continue;
        yield buildItem(scalarSource(item, src), chainId, lineOf, item);
      } else {
        // Non-scalar item inside an address: list is malformed.
        const offset = nodeOffset(item);
        yield {
          line: offset == null ? 0 : lineOf(offset),
          addr: yamlSnippet(item),
          chainId,
          malformed: true,
        };
      }
    }
    return;
  }
  // Anything other than null / scalar / sequence inside `address:` is
  // structurally wrong — treat as a single malformed entry.
  const offset = nodeOffset(value);
  yield {
    line: offset == null ? 0 : lineOf(offset),
    addr: yamlSnippet(value),
    chainId,
    malformed: true,
  };
}

function nodeOffset(node) {
  if (!node) return null;
  if (Array.isArray(node.range) && node.range.length > 0) return node.range[0];
  return null;
}

// Read the raw source slice for a scalar's value, stripping surrounding
// quotes if present. Necessary because yaml@2's parser auto-coerces tokens
// like `0xabc…` to numbers (hex literal); the `.value` field is then a
// useless float. We always want the on-disk literal.
function scalarSource(node, src) {
  if (!Array.isArray(node.range) || node.range.length < 2) {
    return String(node.value);
  }
  const [start, end] = node.range;
  let raw = src.slice(start, end).trim();
  // Strip any inline comment after the value.
  const hash = raw.indexOf("#");
  if (hash >= 0) raw = raw.slice(0, hash).trim();
  // Strip matching wrapping quotes.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw;
}

function yamlSnippet(node) {
  try {
    return JSON.stringify(node.toJSON?.() ?? node).slice(0, 80);
  } catch {
    return "<unprintable>";
  }
}

function buildItem(rawValue, chainId, lineOf, node) {
  const offset = nodeOffset(node);
  const line = offset == null ? 0 : lineOf(offset);
  if (!ADDRESS_RE.test(rawValue)) {
    return { line, addr: rawValue, chainId, malformed: true };
  }
  return { line, addr: rawValue, chainId };
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
  const doc = parseDocument(src, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    drift++;
    for (const err of doc.errors) {
      console.error(`✖ ${rel}  YAML parse error: ${err.message}`);
    }
    continue;
  }
  const lineOf = lineLookupFor(src);
  for (const item of extractAddresses(doc, src, lineOf)) {
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
