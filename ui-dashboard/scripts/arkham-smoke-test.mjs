#!/usr/bin/env node
/**
 * Arkham API smoke test — run locally with the real key to verify access
 * and quality-gate logic before kicking off the cron in production.
 *
 * Usage:
 *   ARKHAM_API_KEY=... node ui-dashboard/scripts/arkham-smoke-test.mjs [address]
 *
 * Defaults to a Binance hot wallet — Arkham consistently labels that, so
 * a healthy run shows "would persist". To probe a specific Mento counterparty,
 * pass its address as the first arg.
 *
 * NOTE: Arkham does not support Celo or Monad. The integration uses the
 * `/all` endpoint to look up addresses on every chain Arkham covers
 * (Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Flare,
 * HyperEVM, plus non-EVM). EVM addresses are chain-agnostic, so attribution
 * from any covered chain applies to the same address on Celo.
 */

import process from "node:process";

const ARKHAM_BASE = "https://api.arkm.com";
const HIGH_CONFIDENCE = 0.85;
// Binance Hot Wallet 14 — Arkham labels this on every covered chain.
const DEFAULT_ADDRESS = "0x28C6c06298d514Db089934071355E5743bf21d60";

async function main() {
  const apiKey = process.env.ARKHAM_API_KEY;
  if (!apiKey) {
    console.error("ARKHAM_API_KEY is not set. export it before running.");
    process.exit(1);
  }
  const address = (process.argv[2] ?? DEFAULT_ADDRESS).toLowerCase();

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

  console.log("→ GET /chains");
  const chainsRes = await fetch(`${ARKHAM_BASE}/chains`, {
    headers: { "API-Key": apiKey },
  });
  if (!chainsRes.ok) {
    console.error(`  ${chainsRes.status} — failed.`);
    process.exit(1);
  }
  const chains = await chainsRes.json();
  console.log(`  ${chains.length} chains supported: ${chains.join(", ")}`);
  if (chains.includes("celo")) {
    console.log("  ✓ celo IS supported — pivot the route back to ?chain=celo");
  }

  console.log(`→ GET /intelligence/address_enriched/${address}/all`);
  const url = new URL(
    `/intelligence/address_enriched/${address}/all`,
    ARKHAM_BASE,
  );
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
  console.log(`  ✓ ${Object.keys(data).length} chain entries`);

  // Quality gate — same logic as `toAddressEntry` in lib/arkham.ts.
  let label;
  let entity;
  let topPred;
  for (const perChain of Object.values(data)) {
    const trimmed = perChain.arkhamLabel?.name?.trim();
    if (!label && trimmed) label = trimmed;
    if (!entity && perChain.arkhamEntity?.name) entity = perChain.arkhamEntity;
    for (const p of perChain.entityPredictions ?? []) {
      if (p.confidence < HIGH_CONFIDENCE) continue;
      if (!topPred || p.confidence > topPred.confidence) topPred = p;
    }
  }

  console.log("\n→ Quality gate:");
  console.log(`  arkhamLabel: ${label ?? "(none)"}`);
  console.log(`  arkhamEntity: ${entity?.name ?? "(none)"}`);
  console.log(
    `  top prediction: ${topPred?.entityId ?? "(none)"} @ ${
      topPred ? `${(topPred.confidence * 100).toFixed(0)}%` : "—"
    }`,
  );
  const usable = Boolean(label) || Boolean(entity) || Boolean(topPred);
  console.log(`  usable: ${usable ? "✓ would persist" : "✗ would skip"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
