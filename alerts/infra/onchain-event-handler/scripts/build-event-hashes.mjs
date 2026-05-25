#!/usr/bin/env node
/**
 * Derive QuickNode webhook event-topic hashes from the vendored Safe ABI.
 *
 * QuickNode's evmContractEvents template (the replacement for the deprecated
 * custom `filter_function` webhook approach) takes `templateArgs.eventHashes`
 * — a list of keccak256(eventSignature) topic hashes that the webhook fires
 * on. We compute them here so Terraform can read a static JSON and the build
 * stays reproducible.
 *
 * Source of truth: `alerts/infra/onchain-event-handler/src/safe-abi.json`. The
 * handler's `constants.ts:extractEventSignatures()` computes the same hashes
 * at runtime — both paths read the same ABI so they stay in lock-step.
 *
 * Run via `pnpm --filter @mento-protocol/alerts-onchain-event-handler
 * build:event-hashes` whenever the Safe ABI changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const keccak = require("keccak");

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(__dirname, "..");
const repoRoot = join(moduleDir, "..", "..", "..");

const abi = JSON.parse(
  readFileSync(join(moduleDir, "src/safe-abi.json"), "utf8"),
);

const events = abi
  .filter((item) => item.type === "event" && item.name)
  .map((item) => {
    const paramTypes = (item.inputs || [])
      .map((i) => {
        // EVM canonical topic0 hashing requires tuple params to be expanded
        // to their `(type1,type2,...)` form — using the literal string `tuple`
        // produces wrong hashes silently. The current Safe ABI v1.3.0 has no
        // tuple-typed event params, but a future ABI bump could introduce
        // one. Fail loudly so the operator implements proper expansion
        // (recursively flattening `i.components` to `(t1,t2,...)`) instead
        // of shipping mismatched topics to QuickNode.
        if (i.type === "tuple" || (i.type || "").startsWith("tuple")) {
          throw new Error(
            `Event ${item.name} has a tuple-typed param — implement canonical expansion of i.components before hashing. See https://docs.soliditylang.org/en/latest/abi-spec.html#json for the encoding rules.`,
          );
        }
        return i.type;
      })
      .filter(Boolean);
    const signature = `${item.name}(${paramTypes.join(",")})`;
    const hash = `0x${keccak("keccak256").update(signature).digest("hex")}`;
    return { name: item.name, signature, hash };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const outPath = join(
  repoRoot,
  "alerts/infra/onchain-event-listeners/event-hashes.json",
);
writeFileSync(outPath, JSON.stringify(events, null, 2) + "\n");

console.log(`Wrote ${events.length} event hashes to ${outPath}`);
