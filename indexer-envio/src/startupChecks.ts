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
 */

export const FPMM_FIRST_DEPLOY_BLOCK: Record<number, number> = {
  42220: 60668100, // Celo mainnet
  143: 60759432, // Monad mainnet
};

/** Maps mainnet chain IDs to their dedicated ENVIO_START_BLOCK_* env var name. */
export const START_BLOCK_ENV_NAME: Record<number, string> = {
  42220: "ENVIO_START_BLOCK_CELO",
  143: "ENVIO_START_BLOCK_MONAD",
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
  strict = process.env.ENVIO_STRICT_START_BLOCK === "true",
): void {
  for (const [chainIdStr, firstDeployBlock] of Object.entries(
    FPMM_FIRST_DEPLOY_BLOCK,
  )) {
    const chainId = Number(chainIdStr);
    const envVal = envOverrides[chainId];
    if (envVal === undefined || envVal === "") continue;
    const startBlock = Number(envVal);
    if (!Number.isFinite(startBlock)) continue;
    if (startBlock > firstDeployBlock) {
      const envVarName = START_BLOCK_ENV_NAME[chainId];
      const msg =
        `[startupChecks] start block for chain ${chainId} is ${startBlock}, ` +
        `but FPMMFactory first deployed at block ${firstDeployBlock}. ` +
        `All factory deploy events will be missed and no pools will be indexed. ` +
        `Lower ${envVarName} to ≤${firstDeployBlock} or remove the override.`;
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
  if (process.env.NODE_ENV === "test") return;
  assertStartBlocksValid({
    42220: process.env.ENVIO_START_BLOCK_CELO,
    143: process.env.ENVIO_START_BLOCK_MONAD,
  });
}
