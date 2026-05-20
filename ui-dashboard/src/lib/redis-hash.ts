import type { Redis } from "@upstash/redis";

// Upstash REST rejects requests around 10 MB. Keep the per-script payload
// below that ceiling. Cross-hash atomic restores fall back to greedy-packed
// sub-batches when the combined payload would exceed this budget — see
// evalHashWriteScript.
export const MAX_REDIS_HASH_REPLACE_BYTES = 8 * 1024 * 1024;
export const REDIS_HSET_FIELD_CHUNK_SIZE = 500;

type RedisEvalClient = Pick<Redis, "eval">;

export type RedisHashReplacement = {
  key: string;
  fields: Record<string, string>;
};

const REPLACE_HASHES_SCRIPT = `
local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}
local argIndex = 1
for keyIndex = 1, #KEYS do
  local key = KEYS[keyIndex]
  local fieldCount = tonumber(ARGV[argIndex])
  argIndex = argIndex + 1

  redis.call('DEL', key)
  if fieldCount > 0 then
    local remainingFields = fieldCount
    while remainingFields > 0 do
      local chunkFieldCount = math.min(remainingFields, hsetFieldChunkSize)
      local chunkEndArg = argIndex + (chunkFieldCount * 2) - 1
      redis.call('HSET', key, unpack(ARGV, argIndex, chunkEndArg))
      argIndex = chunkEndArg + 1
      remainingFields = remainingFields - chunkFieldCount
    end
  end
end
return 1
`;

const MERGE_HASHES_SCRIPT = `
local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}
local argIndex = 1
for keyIndex = 1, #KEYS do
  local key = KEYS[keyIndex]
  local fieldCount = tonumber(ARGV[argIndex])
  argIndex = argIndex + 1

  if fieldCount > 0 then
    local remainingFields = fieldCount
    while remainingFields > 0 do
      local chunkFieldCount = math.min(remainingFields, hsetFieldChunkSize)
      local chunkEndArg = argIndex + (chunkFieldCount * 2) - 1
      redis.call('HSET', key, unpack(ARGV, argIndex, chunkEndArg))
      argIndex = chunkEndArg + 1
      remainingFields = remainingFields - chunkFieldCount
    end
  end
end
return 1
`;

export async function replaceRedisHashes(
  redis: RedisEvalClient,
  replacements: RedisHashReplacement[],
): Promise<void> {
  await evalHashWriteScript(
    redis,
    REPLACE_HASHES_SCRIPT,
    replacements,
    "replacement",
  );
}

export async function mergeRedisHashes(
  redis: RedisEvalClient,
  replacements: RedisHashReplacement[],
): Promise<void> {
  await evalHashWriteScript(
    redis,
    MERGE_HASHES_SCRIPT,
    replacements.filter(
      (replacement) => Object.keys(replacement.fields).length > 0,
    ),
    "merge",
  );
}

function payloadBytesFor(
  script: string,
  replacements: RedisHashReplacement[],
): number {
  const keys = replacements.map((r) => r.key);
  const argv = flattenHashReplacements(replacements);
  return Buffer.byteLength(JSON.stringify([script, keys, argv]), "utf8");
}

/**
 * Bytes the trusted-restore EVAL would send to Upstash for a single hash.
 * Use this for backup-time preflight sizing — the wire payload is meaningfully
 * larger than `JSON.stringify(records)` because each record value gets a
 * second JSON encode inside the Redis HSET argv, plus the script + key array.
 */
export function restoreReplacePayloadBytes(
  replacement: RedisHashReplacement,
): number {
  return payloadBytesFor(REPLACE_HASHES_SCRIPT, [replacement]);
}

/**
 * Greedy-pack the replacements into sub-batches each fitting under the
 * Upstash request cap, in the input order. Throws (without issuing any
 * round-trip) if any single replacement exceeds the cap.
 *
 * The input order matters: callers should list "must stay atomic together"
 * hashes adjacent at the front (e.g. labels + reports). When their combined
 * payload fits one sub-batch, they swap together; the larger Arkham hashes
 * each get their own sub-batch.
 */
function packIntoBatches(
  script: string,
  replacements: RedisHashReplacement[],
  operation: "replacement" | "merge",
): RedisHashReplacement[][] {
  const batches: RedisHashReplacement[][] = [];
  let current: RedisHashReplacement[] = [];
  for (const replacement of replacements) {
    if (payloadBytesFor(script, [replacement]) > MAX_REDIS_HASH_REPLACE_BYTES) {
      throw new Error(
        `Redis hash ${operation} payload for ${replacement.key} exceeds ${MAX_REDIS_HASH_REPLACE_BYTES} bytes`,
      );
    }
    const candidate = [...current, replacement];
    if (
      current.length > 0 &&
      payloadBytesFor(script, candidate) > MAX_REDIS_HASH_REPLACE_BYTES
    ) {
      batches.push(current);
      current = [replacement];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function evalHashWriteScript(
  redis: RedisEvalClient,
  script: string,
  replacements: RedisHashReplacement[],
  operation: "replacement" | "merge",
): Promise<void> {
  if (replacements.length === 0) return;

  // Common case — the whole payload fits a single round-trip, preserving
  // cross-hash atomicity (all hashes swap together or not at all).
  if (payloadBytesFor(script, replacements) <= MAX_REDIS_HASH_REPLACE_BYTES) {
    const keys = replacements.map((r) => r.key);
    const argv = flattenHashReplacements(replacements);
    await redis.eval(script, keys, argv);
    return;
  }

  // Fallback: pack into sub-batches that each fit under the cap. Greedy-pack
  // preserves locality for callers that order related hashes adjacent (e.g.
  // labels + reports at the front stay together inside a single sub-batch
  // even when the broader payload has to be split). Validation runs BEFORE
  // any round-trip so an oversized single hash fails fast without partial
  // writes (codex P1).
  const batches = packIntoBatches(script, replacements, operation);

  // Sequential dispatch. Once we've exceeded the single-script cap, no
  // ordering preserves cross-batch atomicity — but firing them concurrently
  // is worse: a late batch failing while early ones already committed leaves
  // Redis in an unpredictable partial state. Serializing halts the sequence
  // at a known boundary on failure (batches 1..i applied, i+1..N untouched),
  // so an operator can re-run the restore with a deterministic resume point.
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const keys = batch.map((r) => r.key);
    const argv = flattenHashReplacements(batch);
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await runEvalScript(redis, script, keys, argv);
    } catch (err) {
      // Decorate so operators can tell from the error which sub-batches
      // committed (1..i) versus which key-set was being applied when the
      // dispatch broke (batches i+1..N are still in their prior state).
      throw new Error(
        `Redis hash ${operation} failed at sub-batch ${i + 1}/${batches.length} ` +
          `(keys=[${keys.join(", ")}]); sub-batches 1..${i} already committed. ` +
          `Original: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

async function runEvalScript(
  redis: RedisEvalClient,
  script: string,
  keys: string[],
  argv: string[],
): Promise<unknown> {
  return redis.eval(script, keys, argv);
}

export function flattenHashReplacements(
  replacements: RedisHashReplacement[],
): string[] {
  return replacements.flatMap((replacement) => {
    const fields = Object.entries(replacement.fields);
    return [
      String(fields.length),
      ...fields.flatMap(([field, value]) => [field, value]),
    ];
  });
}
