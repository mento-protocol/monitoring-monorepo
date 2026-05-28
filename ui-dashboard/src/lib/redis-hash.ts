import type { Redis } from "@upstash/redis";

// Upstash REST rejects requests around 10 MB. Keep the per-script payload
// below that ceiling. Cross-hash atomic restores fall back to greedy-packed
// sub-batches when the combined payload would exceed this budget — see
// evalHashWriteScript. Single hashes exceeding the cap fall back to chunked
// DEL+HSET dispatch (replace) or chunked HSET dispatch (merge); see
// chunkedHashWrite.
export const MAX_REDIS_HASH_REPLACE_BYTES = 8 * 1024 * 1024;
export const REDIS_HSET_FIELD_CHUNK_SIZE = 500;

// Headroom subtracted from MAX_REDIS_HASH_REPLACE_BYTES when packing chunked
// HSET commands. Covers our approximation error in `hsetCommandBytes` (we
// estimate JSON envelope overhead per pair; actual Upstash wire format can
// vary by a few bytes). 1 KB is overkill for the worst-case fence-post; the
// alternative — over-shoot and have one HSET command get rejected — is far
// worse than slightly more chunks.
const HSET_CHUNK_HEADROOM_BYTES = 1024;

type RedisHashWriteClient = Pick<Redis, "eval" | "del" | "hset">;

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
  redis: RedisHashWriteClient,
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
  redis: RedisHashWriteClient,
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
 * Build an order-preserving dispatch plan from the input replacements.
 * Walks input once: an oversized single hash flushes the current EVAL batch
 * then dispatches as chunked; an EVAL-eligible hash extends the current
 * batch as long as the batch still fits under the cap, else flushes + starts
 * a new batch. The resulting plan preserves input order — so a failure mid-
 * dispatch always halts on the earliest-input replacement that hadn't yet
 * committed, giving operators a predictable resume point.
 */
type HashDispatchUnit =
  | { kind: "eval"; batch: RedisHashReplacement[] }
  | { kind: "chunked"; replacement: RedisHashReplacement };

function planHashDispatch(
  script: string,
  replacements: RedisHashReplacement[],
): HashDispatchUnit[] {
  const plan: HashDispatchUnit[] = [];
  let currentBatch: RedisHashReplacement[] = [];

  const flushBatch = (): void => {
    if (currentBatch.length > 0) {
      plan.push({ kind: "eval", batch: currentBatch });
      currentBatch = [];
    }
  };

  for (const replacement of replacements) {
    if (payloadBytesFor(script, [replacement]) > MAX_REDIS_HASH_REPLACE_BYTES) {
      flushBatch();
      plan.push({ kind: "chunked", replacement });
      continue;
    }
    const candidate = [...currentBatch, replacement];
    if (
      currentBatch.length > 0 &&
      payloadBytesFor(script, candidate) > MAX_REDIS_HASH_REPLACE_BYTES
    ) {
      flushBatch();
      currentBatch = [replacement];
    } else {
      currentBatch = candidate;
    }
  }
  flushBatch();
  return plan;
}

async function evalHashWriteScript(
  redis: RedisHashWriteClient,
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

  // Walk in input order, mixing EVAL batches and chunked dispatches as the
  // hash sizes dictate. Sequential dispatch — once we've exceeded the single-
  // script cap, no ordering preserves cross-batch atomicity, but firing
  // concurrently is worse: a late dispatch failing while earlier ones
  // already committed leaves Redis in an unpredictable partial state.
  // Serializing halts at a known boundary; preserving input order means the
  // halt point is the earliest-input replacement that hadn't yet committed.
  const plan = planHashDispatch(script, replacements);
  const replaceFirst = operation === "replacement";
  for (let i = 0; i < plan.length; i++) {
    const unit = plan[i];
    if (unit === undefined) continue;
    try {
      if (unit.kind === "eval") {
        const keys = unit.batch.map((r) => r.key);
        const argv = flattenHashReplacements(unit.batch);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await runEvalScript(redis, script, keys, argv);
      } else {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await chunkedHashWrite(redis, unit.replacement, { replaceFirst });
      }
    } catch (err) {
      const description =
        unit.kind === "eval"
          ? `EVAL sub-batch keys=[${unit.batch.map((r) => r.key).join(", ")}]`
          : `chunked write for ${unit.replacement.key} (oversized; partial intra-hash state possible)`;
      throw new Error(
        `Redis hash ${operation} failed at dispatch unit ${i + 1}/${plan.length} ` +
          `(${description}); units 1..${i} already committed. ` +
          `Original: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * Exact Upstash REST wire bytes for an `HSET key f1 v1 f2 v2 ...` command —
 * compute the actual JSON encoding length per item rather than approximating
 * raw UTF-8 byte sums. The raw approximation underestimates because Upstash
 * REST encodes the command as a JSON array, escaping every quote/backslash/
 * control character in field names and values. Restored intel records are
 * JSON-encoded strings full of quotes, so the gap is often large enough to
 * push a "fits" chunk past the server cap and fail at runtime — replace mode
 * has already issued DEL by then, leaving the hash partial.
 *
 * Uses `JSON.stringify` per item to get the true encoded length (handles
 * non-ASCII via UTF-8). Plus per-item 1-byte separator (`,`) and 2-byte array
 * brackets. `HSET_CHUNK_HEADROOM_BYTES` is still subtracted at the call site
 * as a guard against any remaining envelope discrepancy.
 */
function hsetCommandBytes(key: string, pairs: Array<[string, string]>): number {
  let bytes = 2; // `[` + `]`
  bytes += Buffer.byteLength(JSON.stringify("HSET"), "utf8");
  bytes += 1 + Buffer.byteLength(JSON.stringify(key), "utf8"); // `,"key"`
  for (const [field, value] of pairs) {
    bytes += 1 + Buffer.byteLength(JSON.stringify(field), "utf8");
    bytes += 1 + Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  return bytes;
}

/**
 * Dispatch a single oversized hash via chunked HSET commands. For replace
 * mode (`replaceFirst: true`), issues a DEL first so the hash is fully
 * cleared before any fields are written. For merge mode (`replaceFirst:
 * false`), skips the DEL.
 *
 * Each HSET batch is sized to stay under
 * `MAX_REDIS_HASH_REPLACE_BYTES - HSET_CHUNK_HEADROOM_BYTES`. Sequential
 * dispatch so a failure halts at a known boundary instead of leaving an
 * arbitrary subset of fields written.
 *
 * Intra-hash atomicity is lost: a failure mid-sequence (after DEL but before
 * the final HSET) leaves the hash partially populated. For disaster-recovery
 * restore — a rare event — accepting partial state beats not being able to
 * restore at all.
 */
async function chunkedHashWrite(
  redis: RedisHashWriteClient,
  replacement: RedisHashReplacement,
  options: { replaceFirst: boolean },
): Promise<void> {
  const { key, fields } = replacement;
  const entries = Object.entries(fields);

  // Pre-scan every field BEFORE any side effect. Single-field-too-big in
  // replace mode used to throw AFTER the DEL ran, leaving the hash empty
  // and unrecoverable. The check now uses the same `cap - headroom` budget
  // the chunk planner uses, so a field at the wire-size edge gets the same
  // safety margin.
  const chunkByteCap = MAX_REDIS_HASH_REPLACE_BYTES - HSET_CHUNK_HEADROOM_BYTES;
  for (const [field, value] of entries) {
    if (hsetCommandBytes(key, [[field, value]]) > chunkByteCap) {
      throw new Error(
        `Single field ${field} on hash ${key} produces an HSET command above ${chunkByteCap} bytes ` +
          `(cap ${MAX_REDIS_HASH_REPLACE_BYTES}, headroom ${HSET_CHUNK_HEADROOM_BYTES}); ` +
          `cannot split further at the field level.`,
      );
    }
  }

  if (options.replaceFirst) {
    await redis.del(key);
  }
  if (entries.length === 0) return;

  let chunk: Array<[string, string]> = [];
  let chunkBytes = hsetCommandBytes(key, []);

  for (const [field, value] of entries) {
    // Per-pair contribution to the next chunk: re-measure as JSON-encoded
    // bytes (not raw UTF-8) so the planner stays aligned with the actual
    // wire payload Upstash sees — every quote/backslash in `field` and
    // `value` gets escaped on the way out.
    const entryBytes =
      1 +
      Buffer.byteLength(JSON.stringify(field), "utf8") +
      1 +
      Buffer.byteLength(JSON.stringify(value), "utf8");

    if (chunk.length > 0 && chunkBytes + entryBytes > chunkByteCap) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await redis.hset(key, Object.fromEntries(chunk));
      chunk = [];
      chunkBytes = hsetCommandBytes(key, []);
    }
    chunk.push([field, value]);
    chunkBytes += entryBytes;
  }
  if (chunk.length > 0) {
    await redis.hset(key, Object.fromEntries(chunk));
  }
}

async function runEvalScript(
  redis: RedisHashWriteClient,
  script: string,
  keys: string[],
  argv: string[],
): Promise<unknown> {
  return redis.eval(script, keys, argv);
}

/**
 * Find the first field/value pair on a hash whose single-pair HSET command
 * would exceed the chunked-dispatch budget (`MAX_REDIS_HASH_REPLACE_BYTES`
 * minus headroom). Returns `null` when every pair fits.
 *
 * Used by the backup route as a preflight: chunked HSET in the restore path
 * throws on the first unsplittable field, so a hash whose blob fits under
 * the restore cap can still deterministically fail to restore if one
 * field/value pair is too big. Catch it at backup time so operators know
 * before relying on the snapshot.
 */
export function findUnchunkableField(
  key: string,
  fields: Record<string, string>,
): { field: string; bytes: number } | null {
  const chunkByteCap = MAX_REDIS_HASH_REPLACE_BYTES - HSET_CHUNK_HEADROOM_BYTES;
  for (const [field, value] of Object.entries(fields)) {
    const bytes = hsetCommandBytes(key, [[field, value]]);
    if (bytes > chunkByteCap) return { field, bytes };
  }
  return null;
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
