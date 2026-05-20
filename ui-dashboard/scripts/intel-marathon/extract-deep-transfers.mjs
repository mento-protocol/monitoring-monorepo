#!/usr/bin/env node
/**
 * Extraction #3 — Deep transfer pagination for top operators.
 *
 * For the 5 most-active Mento operators (rebalancer, cluster deployer, top
 * traders by USD), pulls /transfers?base=X&limit=1000. Overwrites
 * intel_transfers entries with deeper history.
 */

import process from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";

const ARKHAM_BASE = "https://api.arkm.com";
const OUT_DIR = ".intel-marathon";
const HEAVY_SPACING_MS = 1100;
const RATE_LIMIT_BACKOFF_MS = 2000;
const TRANSFERS_LIMIT = 1000;

const required = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ARKHAM_API_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const arkhamKey = process.env.ARKHAM_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  {
    address: "0x7dc08ec28f299c062d2941de1f9cfb741df8f022",
    label: "cluster-7dc08ec-deployer",
  },
  {
    address: "0xaa8299fc6a685b5f9ce9bda8d0b3ea3d54731976",
    label: "mento-rebalancer",
  },
  // 3 top operators by previously-captured Mento volume from forensic targets.
  {
    address: "0x00d1cda22d867e2d2f22931b5567e93cc1e047cd",
    label: "mento-arb-bot-13",
  },
  {
    address: "0x241d80827cf1727f13ab82238938739117ad2aa7",
    label: "mento-v2-oracle-arb",
  },
  {
    address: "0xdec876911cbe9428265af0d12132c52ee8642a99",
    label: "openocean-dex-caller",
  },
];

async function pipeline(commands) {
  const res = await fetch(`${redisUrl}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok)
    throw new Error(`Upstash pipeline → ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // Upstash pipeline returns HTTP 200 even when individual commands fail; scan
  // each entry for a per-command .error so a silent HSET/HVALS failure can't
  // pass as empty success.
  for (let i = 0; i < json.length; i++) {
    if (json[i] && json[i].error) {
      throw new Error(
        `Upstash pipeline cmd[${i}] (${commands[i][0]}): ${json[i].error}`,
      );
    }
  }
  return json;
}

async function fetchTransfers(address, limit = TRANSFERS_LIMIT) {
  const url = `${ARKHAM_BASE}/transfers?base=${address}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "API-Key": arkhamKey },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 401) throw new Error("ARKHAM_AUTH_FAIL");
  if (res.status === 429) throw new Error("ARKHAM_RATE_LIMITED");
  if (!res.ok)
    throw new Error(
      `arkham_http_${res.status}: ${await res.text().catch(() => "")}`,
    );
  return { status: 200, data: await res.json() };
}

async function main() {
  const startedAt = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/extract-deep-transfers-raw.jsonl`;

  console.log(
    `→ Deep-paginating transfers for ${TARGETS.length} targets (limit=${TRANSFERS_LIMIT})`,
  );

  let success = 0,
    errors = 0,
    totalTransfers = 0;

  const MAX_RATE_LIMIT_RETRIES = 5;
  let lastIdx = -1;
  let retriesThisIdx = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    if (lastIdx !== i) {
      lastIdx = i;
      retriesThisIdx = 0;
    }
    const { address, label } = TARGETS[i];
    try {
      const { status, data } = await fetchTransfers(address);
      const count = Array.isArray(data?.transfers) ? data.transfers.length : 0;
      appendFileSync(
        rawFile,
        JSON.stringify({ address, label, status, count, ts: Date.now() }) +
          "\n",
      );
      if (status === 200 && data) {
        const record = {
          address,
          label,
          fetchedAt: new Date().toISOString(),
          transferCount: count,
          ...data,
        };
        let jsonStr = JSON.stringify(record);
        // Aggressive trim if oversized — keep most recent 200 transfers (still 2x our previous snapshot).
        if (jsonStr.length > 49_000) {
          const trimmed = (data.transfers ?? []).slice(0, 200);
          jsonStr = JSON.stringify({
            ...record,
            transfers: trimmed,
            _truncatedFrom: count,
          });
        }
        await pipeline([
          ["HSET", "intel_transfers", address.toLowerCase(), jsonStr],
        ]);
        success++;
        totalTransfers += count;
        console.log(
          `  ✓ ${label} (${address}): ${count} transfers, ${jsonStr.length} B`,
        );
      } else {
        console.log(`  ⚠ ${label}: 404 / no data`);
      }
    } catch (err) {
      if (err.message === "ARKHAM_AUTH_FAIL") {
        console.error("✗ Auth fail — halting.");
        process.exit(2);
      }
      if (err.message === "ARKHAM_RATE_LIMITED") {
        if (++retriesThisIdx > MAX_RATE_LIMIT_RETRIES) {
          errors++;
          console.warn(
            `  ⚠ ${label}: gave up after ${MAX_RATE_LIMIT_RETRIES} 429 retries`,
          );
          continue;
        }
        await sleep(RATE_LIMIT_BACKOFF_MS);
        i--;
        continue;
      }
      errors++;
      console.warn(`  ⚠ ${label} (${address}): ${err.message}`);
    }
    if (i < TARGETS.length - 1) await sleep(HEAVY_SPACING_MS);
  }

  const e = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✓ Deep transfers done in ${e}s.`);
  console.log(`  success:        ${success}/${TARGETS.length}`);
  console.log(`  total xfers:    ${totalTransfers}`);
  console.log(`  errors:         ${errors}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
