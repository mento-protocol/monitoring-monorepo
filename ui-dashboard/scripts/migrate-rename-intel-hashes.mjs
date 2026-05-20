#!/usr/bin/env node
/**
 * One-shot migration: move legacy Redis hash keys to their new intel_* names.
 *
 * Atomic per-pair via Lua EVAL:
 *   - If dst does not exist: RENAME src → dst (fast path).
 *   - If dst already exists (marathon writers may have populated it
 *     post-deploy): HGETALL src, HSETNX every field into dst (dst wins on
 *     collision since dst is the canonical post-deploy writer), DEL src.
 *
 * The merge variant exists because the intel-*.ts libs now read from both
 * hashes (legacy fallback) — a re-run marathon between deploy and migration
 * lands new data on intel_*, and a naive RENAME would overwrite that with
 * the older arkham_* corpus.
 *
 * Idempotent: skips any src key that does not exist.
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=<url> UPSTASH_REDIS_REST_TOKEN=<token> node scripts/migrate-rename-intel-hashes.mjs
 *
 * Or via the marathon runner:
 *   ./scripts/intel-marathon/run.sh migrate-rename
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!REST_URL || !REST_TOKEN) {
  console.error(
    "ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
  );
  process.exit(1);
}

const RENAMES = [
  ["arkham_deep", "intel_deep"],
  ["arkham_transfers", "intel_transfers"],
  ["arkham_wealth", "intel_wealth"],
  ["arkham_entities", "intel_entities"],
  ["arkham_entity_cps", "intel_entity_cps"],
];

const MIGRATE_LUA = `
local src = KEYS[1]
local dst = KEYS[2]
if redis.call('EXISTS', src) == 0 then
  return 'skip:src_missing'
end
if redis.call('EXISTS', dst) == 0 then
  redis.call('RENAME', src, dst)
  return 'renamed'
end
local entries = redis.call('HGETALL', src)
local added = 0
for i = 1, #entries, 2 do
  if redis.call('HSETNX', dst, entries[i], entries[i+1]) == 1 then
    added = added + 1
  end
end
redis.call('DEL', src)
return 'merged:' .. added
`.trim();

async function upstashPost(path, body) {
  const res = await fetch(`${REST_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Upstash error: ${json.error}`);
  return json.result;
}

async function upstashGet(command, ...args) {
  const url = `${REST_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${REST_TOKEN}` },
  });
  const json = await res.json();
  if (json.error) throw new Error(`Upstash error: ${json.error}`);
  return json.result;
}

async function hlen(key) {
  return upstashGet("HLEN", key);
}

async function migratePair(src, dst) {
  // EVAL signature via Upstash REST: [script, [keys], [args]]
  return upstashPost(`/eval`, [MIGRATE_LUA, [src, dst], []]);
}

async function main() {
  console.log("migrate-rename-intel-hashes: starting\n");

  for (const [src, dst] of RENAMES) {
    const srcBefore = await hlen(src);
    const dstBefore = await hlen(dst);
    const outcome = await migratePair(src, dst);
    const dstAfter = await hlen(dst);
    console.log(
      `  ${src} → ${dst}  outcome=${outcome}  ` +
        `(src_before=${srcBefore} dst_before=${dstBefore} dst_after=${dstAfter})`,
    );
  }

  console.log("\nmigrate-rename-intel-hashes: done");
}

main().catch((err) => {
  console.error("migrate-rename-intel-hashes: FAILED", err);
  process.exit(1);
});
