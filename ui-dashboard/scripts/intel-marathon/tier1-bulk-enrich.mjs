#!/usr/bin/env node
/**
 * Tier 1 — bulk Arkham sweep of the distinct EXTERNAL-ACTOR addresses in the
 * indexer's data, via /intelligence/address_enriched/{addr}/all. Persists
 * into Upstash `labels` hash (source: "arkham").
 *
 * Discovery reads the indexer's PER-ADDRESS ROLLUP entities rather than raw
 * event tables: one row per address instead of one row per event, so a full
 * sweep costs ~80 Hasura pages instead of thousands. Rollups carry no chain
 * filter — Arkham keys on the address, and EVM addresses are chain-agnostic.
 * This is narrower than the production cron's DISCOVERY_TARGETS by design:
 * protocol actors (isProtocolActor), router/pool contract fields
 * (SwapEvent.recipient/.txTo, RebalanceEvent.*, Pool.rebalancerAddress), and
 * BridgeTransfer.recipient (≈ its senders) are deliberately excluded.
 * A discovery source that errors ABORTS the run before any quota is spent —
 * a partial set looks identical to full coverage afterwards; pass
 * --allow-partial-discovery to proceed anyway.
 *
 * Enrichment order (cap-aware; the trial's Intel Label quota is the binding
 * constraint, not throughput):
 *   1. existing arkham-sourced `labels` entries (refresh, on by default)
 *   2. every non-Broker-trader discovery (LPs, bridgers, borrowers, SP
 *      depositors, trove owners, OLS callers, FPMM traders, yield positions)
 *   3. Broker traders, descending by lifetime USD volume
 *
 * Write rules:
 *   - manual entries (not arkham-sourced) are never enriched and never touched
 *   - arkham-sourced entries are MERGED with the fresh result on the canonical
 *     `mergeRefreshEntry` rules from ui-dashboard/src/lib/arkham.ts: Arkham
 *     owns `name` and contributes tags, while `createdAt`, `isPublic`, and
 *     user-edited `notes` survive the refresh. Only an auto-generated
 *     "Arkham prediction (…)" note is replaced by the fresh one. A pass-1
 *     entry that a human later curated or published keeps that state.
 *   - a fresh result that fails the quality gate leaves the existing entry
 *     in place
 *   - unlabeled addresses are written as new entries
 *
 * Writes are race-safe. The `labels` snapshot is read once, but the run spans
 * 70+ minutes over ~68k addresses, so a human editing the address book
 * mid-run would otherwise be clobbered by a blind HSET. Mirroring
 * `importLabelsIfAbsent` / `importArkhamRefreshLabelsIfUnchanged` in
 * ui-dashboard/src/lib/address-labels.ts:
 *   - new addresses go in via HSETNX, so anything that appeared at that field
 *     mid-run wins
 *   - refreshes go through a compare-and-set EVAL that writes only while the
 *     stored row is still arkham-sourced AND its `updatedAt` still matches the
 *     snapshot; a user edit or a deletion beats a stale refresh
 * Both checks also enforce the manual-entry rule at the write boundary, not
 * just in the queue filter. Skips are counted and logged per category.
 *
 * Quota: every enrichment response's X-Intel-Datapoints-{Usage,Limit,Remaining}
 * headers are recorded, GET /subscription/intel-usage (free) is polled at start
 * and every 500 addresses, and the run stops cleanly once Remaining reaches
 * --quota-floor. The headers are unverified, so the intel-usage body
 * (totalLimit - totalCount) seeds the same stop logic when they never appear.
 * Two more brakes back that up: HTTP 402/403 halts immediately, and 10
 * consecutive enrichment errors trip a circuit breaker rather than grinding
 * the whole queue into failures.
 *
 * Resumes from .intel-marathon/tier1-progress-{scope}.jsonl on restart.
 *
 * Usage:
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs --dry-run
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ARKHAM_API_KEY=... \
 *   node ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs
 *
 * Flags:
 *   --dry-run          discovery + prioritization + counts only; no Arkham
 *                      calls, no Upstash writes, no files written, and no
 *                      ARKHAM_API_KEY required
 *   --limit N          cap the number of addresses enriched this run
 *   --quota-floor N    stop when Intel Label Remaining <= N (default 50)
 *   --retry-errors     retry error-only progress histories in the normal queue;
 *                      may spend additional Intel Label quota
 *   --no-refresh       skip step 1; only enrich addresses with no label
 *   --allow-partial-discovery
 *                      proceed even when a discovery source errored (the run
 *                      normally aborts to avoid spending quota on a silently
 *                      incomplete sweep)
 *   --allow-unknown-quota
 *                      start even when the startup /subscription/intel-usage
 *                      poll yielded no Remaining (the run normally refuses
 *                      rather than sweep with no quota ceiling visible)
 *   --chain <id>       output-file scope tag only (default "all"). Discovery
 *                      is cross-chain; pass this only to resume a prior
 *                      per-chain progress file.
 */

import process from "node:process";
import { createDiscovery } from "./tier1-discovery.mjs";
import { createQuota } from "./tier1-quota.mjs";
import {
  createLabelStore,
  createWriter,
  toAddressEntry,
  buildWriteEntry,
} from "./tier1-writes.mjs";
import { loadProcessed } from "./tier1-progress.mjs";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const OUT_DIR = ".intel-marathon";
const REQ_SPACING_MS = 60; // standard bucket (100 req/s), ~16 req/s sustained
const RATE_LIMIT_BACKOFF_MS = 1500;
const HSET_BATCH = 100;
const QUOTA_FLOOR_DEFAULT = 50;
const QUOTA_LOG_EVERY = 100; // log header-derived quota every N requests
const INTEL_USAGE_EVERY = 500; // poll /subscription/intel-usage every N addresses
const MAX_CONSECUTIVE_ERRORS = 10; // circuit breaker on a wedged/exhausted API

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const refresh = !args.includes("--no-refresh");
const retryErrors = args.includes("--retry-errors");
const allowPartialDiscovery = args.includes("--allow-partial-discovery");

function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const raw = args[i + 1];
  return raw === undefined || raw.startsWith("--") ? undefined : raw;
}

/**
 * Numeric flag with a hard parse failure. A typo'd `--quota-floor 5O` would
 * otherwise become NaN, and every `remaining <= NaN` comparison is false — the
 * quota brake would look configured and never fire.
 */
function numericFlag(name, fallback) {
  const raw = flagValue(name);
  if (raw === undefined) {
    // A flag typed with no value (or immediately followed by another flag,
    // e.g. `--limit --no-refresh`) must fail loudly rather than silently
    // falling back — for --limit that fallback is Infinity, which would
    // start an unbounded, quota-consuming sweep the caller didn't intend.
    if (args.includes(name)) {
      console.error(
        `Missing value for ${name} (expected a non-negative number)`,
      );
      process.exit(1);
    }
    return fallback;
  }
  // Number("") and Number("   ") are 0, so a shell-expansion accident like
  // `--limit "$UNSET_VAR"` would silently become 0 instead of erroring.
  const parsed = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid ${name}: ${raw} (expected a non-negative number)`);
    process.exit(1);
  }
  return parsed;
}

// `--chain` picks the progress/inventory filenames; silently falling back to
// "all" on a missing value would resume the wrong file.
if (args.includes("--chain") && flagValue("--chain") === undefined) {
  console.error("Missing value for --chain (expected a scope tag)");
  process.exit(1);
}
const scope = flagValue("--chain") ?? "all";
const limitArg = numericFlag("--limit", Infinity);
const quotaFloor = numericFlag("--quota-floor", QUOTA_FLOOR_DEFAULT);

// Discovery is unauthenticated Hasura, so --dry-run needs no credentials.
const required = dryRun
  ? []
  : ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ARKHAM_API_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const arkhamKey = process.env.ARKHAM_API_KEY;
const hasUpstash = Boolean(redisUrl && redisToken);

const { discoverAll, buildQueue } = createDiscovery({
  allowPartialDiscovery,
  refresh,
});
const { getLabels, pipeline } = createLabelStore({ redisUrl, redisToken });
const { quota, quotaLine, logIntelUsage, fetchEnriched } = createQuota({
  arkhamKey,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printPlan(perSource, registry, plan) {
  console.log("");
  console.log("→ Per-source distinct addresses:");
  for (const [key, count] of Object.entries(perSource)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`  TOTAL deduped: ${registry.size}`);
  console.log("");
  console.log("→ Enrichment plan:");
  console.log(`  1. refresh (arkham-sourced labels): ${plan.tiers.refresh}`);
  console.log(`  2. discovery (non-Broker-trader):   ${plan.tiers.discovery}`);
  console.log(
    `  3. Broker traders by volume:        ${plan.tiers.brokerTrader}`,
  );
  console.log(`  skipped, manual label:              ${plan.manualSkipped}`);
  console.log(`  skipped, already arkham-labeled:    ${plan.labeledSkipped}`);
  console.log(`  QUEUE TOTAL:                        ${plan.queue.length}`);
}

async function main() {
  const startedAt = Date.now();
  const { registry, perSource } = await discoverAll();

  // Dry runs still read labels when Upstash creds happen to be present, so the
  // tier sizes are real rather than "everything is new".
  let existing = {};
  if (hasUpstash) {
    console.log("→ Loading existing labels from Upstash...");
    existing = await getLabels();
    console.log(
      `  ${Object.keys(existing).length} entries currently in labels`,
    );
  } else if (dryRun) {
    console.log("→ No Upstash credentials — tier 1 (refresh) reported as 0.");
  }

  const plan = buildQueue(registry, existing);

  if (dryRun) {
    printPlan(perSource, registry, plan);
    const top = plan.queue
      .filter((c) => c.tier === "broker-trader")
      .slice(0, 10);
    if (top.length > 0) {
      console.log("");
      console.log("→ Top Broker traders by lifetime USD volume (wei):");
      for (const c of top) console.log(`  ${c.address} ${c.volumeWei}`);
    }
    console.log("");
    console.log("✓ Dry run — no Arkham calls, no writes.");
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const rawFile = `${OUT_DIR}/tier1-raw-${scope}.jsonl`;
  const progressFile = `${OUT_DIR}/tier1-progress-${scope}.jsonl`;

  // Resume: load already-processed addresses from prior runs.
  const { processed, exists } = loadProcessed(progressFile, { retryErrors });
  if (exists)
    console.log(`→ Resuming: ${processed.size} addresses already processed`);

  writeFileSync(
    `${OUT_DIR}/tier1-inventory-${scope}.json`,
    JSON.stringify(
      {
        scope,
        refresh,
        perSource,
        totalDeduped: registry.size,
        tiers: plan.tiers,
        manualSkipped: plan.manualSkipped,
        labeledSkipped: plan.labeledSkipped,
        queueTotal: plan.queue.length,
      },
      null,
      2,
    ),
  );
  // Per-address provenance, in queue order — what surfaced each address and
  // the lifetime USD volume that ranked it.
  writeFileSync(
    `${OUT_DIR}/tier1-plan-${scope}.jsonl`,
    plan.queue
      .map((c) =>
        JSON.stringify({
          address: c.address,
          tier: c.tier,
          sources: c.sources,
          volumeUsdWei: String(c.volumeWei),
        }),
      )
      .join("\n") + "\n",
  );
  printPlan(perSource, registry, plan);

  let candidates = plan.queue.filter((c) => !processed.has(c.address));
  if (candidates.length > limitArg) candidates = candidates.slice(0, limitArg);
  console.log("");
  console.log(`→ ${candidates.length} addresses to enrich this run`);

  await logIntelUsage("start");
  // Fail closed on unknown quota. If the startup poll yielded nothing (timeout,
  // non-2xx, unrecognized body) and no header has reported Remaining, the floor
  // check would compare against null forever and the sweep would run unbounded.
  // Headers only start arriving with the first enrichment response, so this is
  // the last safe moment to refuse.
  if (quota.remaining === null && !args.includes("--allow-unknown-quota")) {
    console.error(
      "✗ Quota unknown: /subscription/intel-usage yielded no Remaining. " +
        "Refusing to start an unbounded sweep — retry, or pass " +
        "--allow-unknown-quota to proceed on header-based accounting alone.",
    );
    process.exit(1);
  }

  let attested = 0;
  let nullCount = 0;
  let errorCount = 0;
  let stoppedForQuota = false;
  let consecutiveErrors = 0;
  const writer = createWriter({ pipeline, appendFileSync, progressFile });
  const { pendingWrites, flushWrites } = writer;

  /** Halt on errors that every remaining address would hit too. */
  async function haltIfFatal(message) {
    if (message === "ARKHAM_AUTH_FAIL") {
      console.error("✗ Arkham key rejected. Halting.");
      await flushWrites();
      process.exit(2);
    }
    if (message === "ARKHAM_ENTITLEMENT") {
      console.error(
        "✗ Arkham returned 402/403 — plan entitlement or Intel Label quota exhausted. Halting.",
      );
      console.error(`  quota: ${quotaLine()}`);
      console.error(
        `  Re-run once the quota resets; ${progressFile} resumes unattempted work. Default resume skips recorded errors; add --retry-errors to retry them (additional Intel Label quota may be spent).`,
      );
      await flushWrites();
      process.exit(2);
    }
  }

  /**
   * Count one failure and trip the circuit breaker at the limit. Without this
   * an API that starts refusing every call (quota exhaustion behind a status
   * code we don't special-case, or an outage) would grind the whole queue into
   * errors before anyone noticed.
   */
  async function noteFailure(message) {
    errorCount++;
    consecutiveErrors++;
    if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) return;
    await flushWrites();
    console.error("");
    console.error(
      `✗ ${MAX_CONSECUTIVE_ERRORS} consecutive Arkham errors — halting.`,
    );
    console.error(`  last error: ${message}`);
    console.error(`  quota: ${quotaLine()}`);
    console.error(
      `  Check GET /subscription/intel-usage; ${progressFile} resumes unattempted work. Default resume skips recorded errors; add --retry-errors to retry them (additional Intel Label quota may be spent).`,
    );
    process.exit(3);
  }

  function recordResult(address, status, data) {
    // The call itself succeeded (200 or a clean 404), so the API is answering.
    consecutiveErrors = 0;
    if (status !== 200 || !data) {
      nullCount++;
      appendFileSync(progressFile, JSON.stringify({ address, status }) + "\n");
      return;
    }
    // Body-sourced `remaining` only refreshes via the periodic
    // /subscription/intel-usage poll below, so it can otherwise sit stale for
    // up to INTEL_USAGE_EVERY requests while the floor check keeps comparing
    // against it. Decrement it locally on every 200-with-data lookup — each
    // one consumed an Intel Label datapoint on Arkham's side regardless of
    // our own quality gate — so the floor check stays live between polls.
    // Gate on remainingFromHeaders, NOT fromHeaders: a response that carries
    // Usage/Limit but omits Remaining still leaves `remaining` body-sourced,
    // and must keep this decrement active. Once a header reports Remaining,
    // noteQuotaHeaders() takes over per-request and this is a no-op.
    if (!quota.remainingFromHeaders && quota.remaining !== null) {
      quota.remaining -= 1;
    }
    const entry = toAddressEntry(data);
    if (!entry) {
      // Quality gate failed. On a refresh this deliberately leaves the prior
      // entry in place rather than deleting it.
      nullCount++;
      appendFileSync(progressFile, JSON.stringify({ address, status }) + "\n");
      return;
    }
    // The start snapshot decides the write mode. Absent then → HSETNX now;
    // present then → compare-and-set against the `updatedAt` we read.
    // Progress for this address is recorded once the write is durably
    // confirmed (flushNewWrites/flushRefreshWrites/noteSkip), not here —
    // recording it now would let a resumed run skip an address whose label
    // write never actually landed (e.g. the process halts on a flush
    // failure before this batch is retried).
    const current = existing[address];
    pendingWrites.push({
      address,
      entry: buildWriteEntry(entry, current),
      mode: current ? "refresh" : "new",
      expectedUpdatedAt:
        typeof current?.updatedAt === "string" ? current.updatedAt : "",
    });
    attested++;
  }

  for (let i = 0; i < candidates.length; i++) {
    const address = candidates[i].address;
    if (quota.remaining !== null && quota.remaining <= quotaFloor) {
      stoppedForQuota = true;
      break;
    }
    try {
      const { status, data, dropped } = await fetchEnriched(address);
      appendFileSync(
        rawFile,
        JSON.stringify({ address, status, data, ts: Date.now() }) + "\n",
      );
      // recordResult() records progress itself, once the outcome (no write
      // needed, or the write's durable result) is actually known.
      recordResult(address, status, data);
      if (dropped) console.log(`  quota ↓ after ${address}: ${quotaLine()}`);
    } catch (err) {
      await haltIfFatal(err.message);
      if (err.message === "ARKHAM_RATE_LIMITED") {
        console.warn(
          `  ⚠ 429 on ${address}, backing off ${RATE_LIMIT_BACKOFF_MS}ms`,
        );
        await sleep(RATE_LIMIT_BACKOFF_MS);
        // Retry once
        try {
          const { status, data } = await fetchEnriched(address);
          appendFileSync(
            rawFile,
            JSON.stringify({ address, status, data, ts: Date.now() }) + "\n",
          );
          recordResult(address, status, data);
        } catch (retryErr) {
          // A key rotated or a plan exhausted mid-batch is still fatal here.
          await haltIfFatal(retryErr.message);
          appendFileSync(
            progressFile,
            JSON.stringify({ address, error: retryErr.message }) + "\n",
          );
          await noteFailure(retryErr.message);
        }
      } else {
        appendFileSync(
          progressFile,
          JSON.stringify({ address, error: err.message }) + "\n",
        );
        await noteFailure(err.message);
      }
    }
    // Outside the Arkham try/catch above: a storage failure here is not an
    // Arkham enrichment error and must not be absorbed by noteFailure() (which
    // would reset consecutiveErrors on the next successful fetch and mask a
    // sustained Upstash outage from the circuit breaker). Let it propagate to
    // main().catch() and halt the run instead of grinding through the whole
    // queue while silently writing nothing.
    if (pendingWrites.length >= HSET_BATCH) await flushWrites();
    const done = i + 1;
    if (done % QUOTA_LOG_EVERY === 0) {
      await flushWrites();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `  [${done}/${candidates.length}] attested=${attested} written=${writer.counts.written} skipExists=${writer.counts.newSkippedExists} skipChanged=${writer.counts.refreshSkippedChanged} null=${nullCount} errors=${errorCount} elapsed=${elapsed}s ${quotaLine()}`,
      );
    }
    // Tighten the poll cadence near the floor while quota is body-sourced —
    // the local per-address decrement above is a best-effort estimate (an
    // unlabeled 404 may not consume a datapoint the same way), so refresh
    // against the authoritative body more often once the estimate is close
    // enough to the floor that a 500-request gap between real polls risks
    // overshooting it.
    const intelUsageEvery =
      !quota.remainingFromHeaders &&
      quota.remaining !== null &&
      quota.remaining - quotaFloor < 500
        ? 100
        : INTEL_USAGE_EVERY;
    if (done % intelUsageEvery === 0) await logIntelUsage(`after ${done}`);
    if (i < candidates.length - 1) await sleep(REQ_SPACING_MS);
  }

  await flushWrites();
  await logIntelUsage("end");
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  if (stoppedForQuota) {
    console.log(
      `⚠ Stopped early: Intel Label remaining hit the --quota-floor of ${quotaFloor}.`,
    );
    console.log(
      `  Re-run after the quota resets; ${progressFile} resumes unattempted work. Default resume skips recorded errors; add --retry-errors to retry them (additional Intel Label quota may be spent).`,
    );
  }
  console.log(`✓ Tier 1 scope=${scope} done in ${elapsed}s.`);
  console.log(`  queued:        ${candidates.length}`);
  console.log(`  attested:      ${attested}   (passed the quality gate)`);
  console.log(`  written:       ${writer.counts.written}`);
  console.log(
    `  skipped, field appeared mid-run: ${writer.counts.newSkippedExists}`,
  );
  console.log(
    `  skipped, entry changed mid-run:  ${writer.counts.refreshSkippedChanged}`,
  );
  console.log(`  null:          ${nullCount}`);
  console.log(`  errors:        ${errorCount}`);
  console.log(`  quota:         ${quotaLine()}`);
  console.log(`  raw:           ${rawFile}`);
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
