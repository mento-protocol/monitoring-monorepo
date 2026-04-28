#!/usr/bin/env node
/**
 * Arkham API smoke test — run locally with the real key to verify access
 * before kicking off the cron in production.
 *
 * Usage:
 *   ARKHAM_API_KEY=... node ui-dashboard/scripts/arkham-smoke-test.mjs
 *
 * Optional: pass an address as the first arg to test enrichment on that
 * address. Defaults to the FPMM USDm/USDC pool on Celo (which we expect
 * Arkham to know as a contract, possibly with a Mento Labs deployer).
 */

import process from "node:process";

const ARKHAM_BASE = "https://api.arkm.com";
const DEFAULT_ADDRESS = "0x462fe04b4fd719cbd04c0310365d421d02aaa19e"; // USDm/USDC FPMM
const CHAIN = "celo";

async function main() {
  const apiKey = process.env.ARKHAM_API_KEY;
  if (!apiKey) {
    console.error("ARKHAM_API_KEY is not set. export it before running.");
    process.exit(1);
  }
  const address = (process.argv[2] ?? DEFAULT_ADDRESS).toLowerCase();

  // 1) Health
  console.log("→ GET /health");
  const healthRes = await fetch(`${ARKHAM_BASE}/health`, {
    headers: { "API-Key": apiKey },
  });
  console.log(`  ${healthRes.status} ${healthRes.statusText}`);
  if (healthRes.status === 401) {
    console.error("  401 — key rejected. Check it's correct and not expired.");
    process.exit(1);
  }
  if (!healthRes.ok) {
    console.error("  health check failed.");
    process.exit(1);
  }

  // 2) Chains — verify celo is in the supported set
  console.log("→ GET /chains");
  const chainsRes = await fetch(`${ARKHAM_BASE}/chains`, {
    headers: { "API-Key": apiKey },
  });
  if (!chainsRes.ok) {
    console.error(`  ${chainsRes.status} — failed.`);
    process.exit(1);
  }
  const chains = await chainsRes.json();
  console.log(`  ${chains.length} chains supported`);
  if (!chains.includes(CHAIN)) {
    console.error(`  ⚠ chain "${CHAIN}" NOT in the chain enum:`, chains);
    process.exit(1);
  }
  console.log(`  ✓ "${CHAIN}" is supported`);

  // 3) Address enrichment
  console.log(`→ GET /intelligence/address_enriched/${address}?chain=${CHAIN}`);
  const url = new URL(
    `/intelligence/address_enriched/${address}`,
    ARKHAM_BASE,
  );
  url.searchParams.set("chain", CHAIN);
  url.searchParams.set("includeTags", "true");
  url.searchParams.set("includeEntityPredictions", "true");
  url.searchParams.set("includeClusters", "false");

  const enrichRes = await fetch(url, { headers: { "API-Key": apiKey } });
  console.log(`  ${enrichRes.status} ${enrichRes.statusText}`);
  if (enrichRes.status === 404) {
    console.log("  → no Arkham data for this address (normal, not an error).");
    console.log("  Try another address: pass it as the first arg.");
    process.exit(0);
  }
  if (!enrichRes.ok) {
    console.error("  unexpected error");
    console.error(await enrichRes.text());
    process.exit(1);
  }
  const data = await enrichRes.json();
  console.log("  ✓ response:");
  console.log(JSON.stringify(data, null, 2));

  // Quality summary
  const label = data.arkhamLabel?.name;
  const entity = data.arkhamEntity?.name;
  const topPred = (data.entityPredictions ?? []).sort(
    (a, b) => b.confidence - a.confidence,
  )[0];
  console.log("\n→ Quality gate:");
  console.log(`  arkhamLabel: ${label ?? "(none)"}`);
  console.log(`  arkhamEntity: ${entity ?? "(none)"}`);
  console.log(
    `  top prediction: ${topPred?.entityId ?? "(none)"} @ ${
      topPred ? `${(topPred.confidence * 100).toFixed(0)}%` : "—"
    }`,
  );
  const usable =
    Boolean(label) ||
    Boolean(entity) ||
    Boolean(topPred && topPred.confidence >= 0.85);
  console.log(`  usable: ${usable ? "✓ would persist" : "✗ would skip"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
