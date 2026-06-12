import { env } from "./env.js";

/**
 * startupChecks.ts — Startup invariant validation
 *
 * Checks that ENVIO_START_BLOCK_* env vars are not set above the first
 * FPMMFactory deployment block for each mainnet chain. If start_block is too
 * high, FPMMDeployed events are never seen, contractRegister never fires, and
 * all pool events are silently dropped with no error.
 *
 * Only mainnet chains are checked here. Testnet env vars are excluded to
 * avoid false-fatal errors when a leftover value from a prior testnet run is
 * still in .env during a mainnet or unrelated testnet startup.
 *
 * Behavior:
 * - Default (local dev): logs a console.warn, does not throw.
 * - Strict mode (ENVIO_STRICT_START_BLOCK=true, set in CI/hosted): throws.
 * - Test runs (NODE_ENV=test): skipped entirely at module load time to prevent
 *   env vars set in the shell from interfering with unrelated test suites.
 *
 * First factory deployment blocks:
 *   Celo mainnet (42220):  60668100 — initial batch of 4 FPMM pools
 *   Monad mainnet (143):   60759432 — initial batch of 3 FPMM pools
 * First sUSDS tracked reserve movement:
 *   Ethereum mainnet (1):   22994825 — initial Mento reserve sUSDS deposit
 */

export const FPMM_FIRST_DEPLOY_BLOCK: Record<number, number> = {
  42220: 60668100, // Celo mainnet
  143: 60759432, // Monad mainnet
};

export const SUSDS_FIRST_TRACKED_EVENT_BLOCK = 22994825;

const FIRST_REQUIRED_EVENT_BLOCK: Record<number, number> = {
  ...FPMM_FIRST_DEPLOY_BLOCK,
  1: SUSDS_FIRST_TRACKED_EVENT_BLOCK,
};

/** Maps mainnet chain IDs to their dedicated ENVIO_START_BLOCK_* env var name. */
export const START_BLOCK_ENV_NAME: Record<number, string> = {
  42220: "ENVIO_START_BLOCK_CELO",
  143: "ENVIO_START_BLOCK_MONAD",
  1: "ENVIO_START_BLOCK_ETHEREUM",
};

/**
 * Validate that no ENVIO_START_BLOCK_* override is set above the first
 * FPMMFactory deployment block for its chain.
 *
 * @param envOverrides - Map from chain ID to env var value string.
 * @param strict - If true, throws on violation. Defaults to ENVIO_STRICT_START_BLOCK=true.
 */
export function assertStartBlocksValid(
  envOverrides: Record<number, string | undefined>,
  strict = env.ENVIO_STRICT_START_BLOCK,
): void {
  for (const [chainIdStr, firstRequiredBlock] of Object.entries(
    FIRST_REQUIRED_EVENT_BLOCK,
  )) {
    const chainId = Number(chainIdStr);
    const envVal = envOverrides[chainId];
    if (envVal === undefined || envVal === "") continue;
    const startBlock = Number(envVal);
    if (!Number.isFinite(startBlock)) continue;
    if (startBlock > firstRequiredBlock) {
      const envVarName = START_BLOCK_ENV_NAME[chainId];
      const msg =
        `[startupChecks] start block for chain ${chainId} is ${startBlock}, ` +
        `but the first required indexed event is at block ${firstRequiredBlock}. ` +
        `Required historical events will be missed. ` +
        `Lower ${envVarName} to ≤${firstRequiredBlock} or remove the override.`;
      if (strict) {
        throw new Error(`FATAL: ${msg}`);
      } else {
        console.warn(`⚠️  WARNING: ${msg}`);
      }
    }
  }
}

/**
 * Run the start-block check at startup unless running in test mode.
 * Call this once from the Envio entry point (EventHandlers.ts).
 */
export function runStartupChecks(): void {
  // Skip in test mode — shell env vars must not interfere with test suites.
  if (env.NODE_ENV === "test") return;
  assertStartBlocksValid({
    42220: env.ENVIO_START_BLOCK_CELO,
    143: env.ENVIO_START_BLOCK_MONAD,
    1: env.ENVIO_START_BLOCK_ETHEREUM,
  });
}
