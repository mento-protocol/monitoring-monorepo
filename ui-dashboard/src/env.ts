import { z } from "zod/mini";

// Stringly-typed boolean: `"true"` → true, anything else (including `"1"`,
// `"yes"`, `"TRUE"`, operator typos, missing) → false. Matches the prior
// `process.env.X === "true"` semantics exactly. Using an optional string
// instead of `z.enum(["true","false"])` so a typo
// doesn't crash the dashboard at module load. See
// docs/pr-checklists/code-health.md "Adjacent enforced conventions".
const envBool = z.pipe(
  z.optional(z.string()),
  z.transform((value) => value === "true"),
);

// Client-side env vars (NEXT_PUBLIC_* — inlined by Next.js at build time).
// `process.env.NEXT_PUBLIC_X` must be statically referenced in the parse-call
// object so Next.js inlines the value into the client bundle; never `parse(process.env)`.
//
// URL fields with a hardcoded default use `.catch()` (not `.default()`) so a
// `NEXT_PUBLIC_RPC_URL_CELO=""` (Vercel "set but empty") falls back to the
// default instead of failing `.url()` validation and crashing at module load.
const clientSchema = z.object({
  NEXT_PUBLIC_HASURA_URL: z.catch(z.optional(z.url()), undefined),
  NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA: z.catch(z.optional(z.url()), undefined),
  NEXT_PUBLIC_HASURA_URL_TESTNET: z.catch(z.optional(z.url()), undefined),
  NEXT_PUBLIC_RPC_URL_CELO: z.catch(z.url(), "https://forno.celo.org"),
  NEXT_PUBLIC_RPC_URL_MONAD_MAINNET: z.catch(z.url(), "https://rpc2.monad.xyz"),
  NEXT_PUBLIC_RPC_URL_MONAD_TESTNET: z.catch(
    z.url(),
    "https://testnet-rpc.monad.xyz",
  ),
  NEXT_PUBLIC_RPC_URL_POLYGON_MAINNET: z.catch(
    z.url(),
    "https://polygon.drpc.org",
  ),
  NEXT_PUBLIC_RPC_URL_POLYGON_AMOY: z.catch(
    z.url(),
    "https://polygon-amoy.drpc.org",
  ),
  NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA: z.catch(
    z.url(),
    "https://forno.celo-sepolia.celo-testnet.org",
  ),
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_MONAD_TESTNET: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_POLYGON_MAINNET: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_POLYGON_AMOY: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_LOCAL: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_LOCAL: z.catch(
    z.optional(z.url()),
    undefined,
  ),
  NEXT_PUBLIC_SHOW_LOCAL_NETWORKS: envBool,
  NEXT_PUBLIC_SHOW_TESTNET_NETWORKS: envBool,
  NEXT_PUBLIC_BROWSER_TEST_FIXTURES: envBool,
  NEXT_PUBLIC_SENTRY_DSN: z.catch(z.optional(z.url()), undefined),
  // Inlined by next.config.ts from the Vercel deployment/commit identity.
  // `dev` keeps non-Vercel tests and localhost deterministic.
  NEXT_PUBLIC_SWR_CACHE_BUILD_SALT: z._default(
    z.string().check(z.minLength(1)),
    "dev",
  ),
  // `next.config.ts` inlines `NEXT_PUBLIC_VERCEL_ENV=""` on localhost (mirror of
  // `VERCEL_ENV`, which is unset off-Vercel). `.catch(undefined)` so that
  // empty-string case — load-bearing for `shouldEnableSentry` — resolves to
  // `undefined` instead of crashing the dashboard at module load.
  NEXT_PUBLIC_VERCEL_ENV: z.catch(
    z.optional(z.enum(["production", "preview", "development"])),
    undefined,
  ),
});

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_HASURA_URL: process.env.NEXT_PUBLIC_HASURA_URL,
  NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA:
    process.env.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA,
  NEXT_PUBLIC_HASURA_URL_TESTNET: process.env.NEXT_PUBLIC_HASURA_URL_TESTNET,
  NEXT_PUBLIC_RPC_URL_CELO: process.env.NEXT_PUBLIC_RPC_URL_CELO,
  NEXT_PUBLIC_RPC_URL_MONAD_MAINNET:
    process.env.NEXT_PUBLIC_RPC_URL_MONAD_MAINNET,
  NEXT_PUBLIC_RPC_URL_MONAD_TESTNET:
    process.env.NEXT_PUBLIC_RPC_URL_MONAD_TESTNET,
  NEXT_PUBLIC_RPC_URL_POLYGON_MAINNET:
    process.env.NEXT_PUBLIC_RPC_URL_POLYGON_MAINNET,
  NEXT_PUBLIC_RPC_URL_POLYGON_AMOY:
    process.env.NEXT_PUBLIC_RPC_URL_POLYGON_AMOY,
  NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA:
    process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA,
  NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET,
  NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET,
  NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA:
    process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA,
  NEXT_PUBLIC_EXPLORER_URL_MONAD_TESTNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_TESTNET,
  NEXT_PUBLIC_EXPLORER_URL_POLYGON_MAINNET:
    process.env.NEXT_PUBLIC_EXPLORER_URL_POLYGON_MAINNET,
  NEXT_PUBLIC_EXPLORER_URL_POLYGON_AMOY:
    process.env.NEXT_PUBLIC_EXPLORER_URL_POLYGON_AMOY,
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
  NEXT_PUBLIC_SWR_CACHE_BUILD_SALT:
    process.env.NEXT_PUBLIC_SWR_CACHE_BUILD_SALT,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
});
