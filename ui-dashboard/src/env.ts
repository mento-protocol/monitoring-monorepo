import { z } from "zod";

// Stringly-typed boolean: `"true"` → true, anything else → false.
const envBool = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

// Client-side env vars (NEXT_PUBLIC_* — inlined by Next.js at build time).
// `process.env.NEXT_PUBLIC_X` must be statically referenced in the parse-call
// object so Next.js inlines the value into the client bundle; never `parse(process.env)`.
//
// URL fields with a hardcoded default use `.catch()` (not `.default()`) so a
// `NEXT_PUBLIC_RPC_URL_CELO=""` (Vercel "set but empty") falls back to the
// default instead of failing `.url()` validation and crashing at module load.
const clientSchema = z.object({
  NEXT_PUBLIC_HASURA_URL: z.string().url().optional().catch(undefined),
  NEXT_PUBLIC_RPC_URL_CELO: z.string().url().catch("https://forno.celo.org"),
  NEXT_PUBLIC_RPC_URL_MONAD_MAINNET: z
    .string()
    .url()
    .catch("https://rpc2.monad.xyz"),
  NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA: z
    .string()
    .url()
    .catch("https://forno.celo-sepolia.celo-testnet.org"),
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET: z.string().url().optional(),
  NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET: z.string().url().optional(),
  NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_LOCAL: z.string().url().optional(),
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_LOCAL: z.string().url().optional(),
  NEXT_PUBLIC_SHOW_LOCAL_NETWORKS: envBool,
  NEXT_PUBLIC_SHOW_TESTNET_NETWORKS: envBool,
  NEXT_PUBLIC_BROWSER_TEST_FIXTURES: envBool,
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_VERCEL_ENV: z
    .enum(["production", "preview", "development"])
    .optional(),
});

// Server-side env vars consumed via `serverEnv.X`. Other server env vars
// (auth, redis, hasura proxy secrets, cron, third-party API keys) are read
// directly via `process.env.X` in files whose vitest suites stub them at
// call time with `vi.stubEnv()`; the static parse here runs before any test
// hook fires, so routing them through `serverEnv` would break those tests.
const serverSchema = z.object({
  VERCEL: z.string().optional(),
  NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),
});

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_HASURA_URL: process.env.NEXT_PUBLIC_HASURA_URL,
  NEXT_PUBLIC_RPC_URL_CELO: process.env.NEXT_PUBLIC_RPC_URL_CELO,
  NEXT_PUBLIC_RPC_URL_MONAD_MAINNET:
    process.env.NEXT_PUBLIC_RPC_URL_MONAD_MAINNET,
  NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA:
    process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA,
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET,
  NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET,
  NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_LOCAL:
    process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_LOCAL,
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_LOCAL:
    process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_LOCAL,
  NEXT_PUBLIC_SHOW_LOCAL_NETWORKS: process.env.NEXT_PUBLIC_SHOW_LOCAL_NETWORKS,
  NEXT_PUBLIC_SHOW_TESTNET_NETWORKS:
    process.env.NEXT_PUBLIC_SHOW_TESTNET_NETWORKS,
  NEXT_PUBLIC_BROWSER_TEST_FIXTURES:
    process.env.NEXT_PUBLIC_BROWSER_TEST_FIXTURES,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
});

export const serverEnv = serverSchema.parse({
  VERCEL: process.env.VERCEL,
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
});
