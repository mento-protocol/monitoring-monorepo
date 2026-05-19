import { z } from "zod";

// `.catch(default)` (not `.default(default)`) so missing AND invalid input
// both resolve to the safe default. This matches the prior `Number(x) ||
// fallback` / `x === "true"` semantics so operator typos (e.g.
// `INDEXER_PERF_LOG_INTERVAL_EVENTS=abc`, `NODE_ENV=staging`,
// `ENVIO_STRICT_START_BLOCK=1`) silently resolve instead of crashing the
// indexer at module load. See AGENTS.md "Env-var validation".
const envBool = z
  .string()
  .optional()
  .transform((v) => v === "true");

const schema = z.object({
  INDEXER_PERF: z.string().optional(),
  INDEXER_PERF_LOG_INTERVAL_EVENTS: z.coerce.number().positive().catch(10_000),

  ENVIO_STRICT_START_BLOCK: envBool,

  ENVIO_START_BLOCK_CELO: z.string().optional(),
  ENVIO_START_BLOCK_MONAD: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).catch("development"),

  ENVIO_TEST_RPC_PORT: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .catch(undefined),
});

// `rpc/client.ts` reads `ENVIO_API_TOKEN` / `ENVIO_RPC_URL` /
// `ENVIO_RPC_URL_<chainId>` directly because its tests stub those at call
// time; the static parse here runs before any test hook fires.
export const env = schema.parse({
  INDEXER_PERF: process.env.INDEXER_PERF,
  INDEXER_PERF_LOG_INTERVAL_EVENTS:
    process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS,
  ENVIO_STRICT_START_BLOCK: process.env.ENVIO_STRICT_START_BLOCK,
  ENVIO_START_BLOCK_CELO: process.env.ENVIO_START_BLOCK_CELO,
  ENVIO_START_BLOCK_MONAD: process.env.ENVIO_START_BLOCK_MONAD,
  NODE_ENV: process.env.NODE_ENV,
  ENVIO_TEST_RPC_PORT: process.env.ENVIO_TEST_RPC_PORT,
});
