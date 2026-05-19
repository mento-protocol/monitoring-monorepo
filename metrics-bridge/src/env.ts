import { z } from "zod";

// `.catch(default)` (not `.default(default)`) so missing AND invalid input
// both resolve to the safe default. Mutation tests assume operator typos
// (e.g. `REBALANCE_PROBE_EVERY_N_POLLS=0`) silently fall back at startup
// instead of crashing the service.
const schema = z.object({
  HASURA_URL: z
    .string()
    .url()
    .catch("https://indexer.hyperindex.xyz/2f3dd15/v1/graphql"),
  POLL_INTERVAL_MS: z.coerce.number().min(1000).catch(30_000),
  PORT: z.coerce.number().min(1).max(65535).catch(8080),
  REBALANCE_PROBE_EVERY_N_POLLS: z.coerce.number().min(1).catch(5),
  REBALANCE_PROBE_CONCURRENCY: z.coerce.number().min(1).catch(5),
  REBALANCE_PROBE_TIMEOUT_MS: z.coerce.number().min(1000).catch(8_000),
});

export const env = schema.parse({
  HASURA_URL: process.env.HASURA_URL,
  POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
  PORT: process.env.PORT,
  REBALANCE_PROBE_EVERY_N_POLLS: process.env.REBALANCE_PROBE_EVERY_N_POLLS,
  REBALANCE_PROBE_CONCURRENCY: process.env.REBALANCE_PROBE_CONCURRENCY,
  REBALANCE_PROBE_TIMEOUT_MS: process.env.REBALANCE_PROBE_TIMEOUT_MS,
});
