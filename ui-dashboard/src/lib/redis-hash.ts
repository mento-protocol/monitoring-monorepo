import type { Redis } from "@upstash/redis";

// Upstash REST rejects requests around 10 MB. Keep the replacement budget below
// that ceiling because a restore EVAL wraps the payload in a JSON request body.
export const MAX_REDIS_HASH_REPLACE_BYTES = 8 * 1024 * 1024;

type RedisEvalClient = Pick<Redis, "eval">;

export type RedisHashReplacement = {
  key: string;
  fields: Record<string, string>;
};

const REPLACE_HASHES_SCRIPT = `
local argIndex = 1
for keyIndex = 1, #KEYS do
  local key = KEYS[keyIndex]
  local fieldCount = tonumber(ARGV[argIndex])
  argIndex = argIndex + 1

  redis.call('DEL', key)
  for _ = 1, fieldCount do
    redis.call('HSET', key, ARGV[argIndex], ARGV[argIndex + 1])
    argIndex = argIndex + 2
  end
end
return 1
`;

export async function replaceRedisHashes(
  redis: RedisEvalClient,
  replacements: RedisHashReplacement[],
): Promise<void> {
  if (replacements.length === 0) return;

  const keys = replacements.map((replacement) => replacement.key);
  const argv = flattenHashReplacements(replacements);
  const requestBytes = Buffer.byteLength(
    JSON.stringify([REPLACE_HASHES_SCRIPT, keys, argv]),
    "utf8",
  );
  if (requestBytes > MAX_REDIS_HASH_REPLACE_BYTES) {
    throw new Error(
      `Redis hash replacement payload exceeds ${MAX_REDIS_HASH_REPLACE_BYTES} bytes`,
    );
  }

  await redis.eval(REPLACE_HASHES_SCRIPT, keys, argv);
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
