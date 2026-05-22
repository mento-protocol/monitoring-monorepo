// ---------------------------------------------------------------------------
// Shared indexer constants
// ---------------------------------------------------------------------------

/** All-zero EVM address. Surfaces in event params, return values for
 *  destroyed exchanges, schema defaults for unknown feeds, etc. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** V3 hub USDm collateral on Celo — distinct on-chain contract from V2
 *  cUSD-USDm (`0x765de8…`). Hardcoded here because `@mento-protocol/contracts`
 *  still maps the bare "USDm" key to V2 cUSD; once the upstream package
 *  republishes USDm at this address, this constant + the two import sites
 *  (`handlers/liquity/config.ts`, `handlers/v2Stables/config.ts`) + the
 *  matching ALLOWLIST entry in `scripts/checkYamlAddresses.mjs` all become
 *  dead code that can be cleaned up in one PR. Single-source so the address
 *  doesn't drift across modules. */
export const V3_HUB_USDM_ADDRESS = "0x106cc9ff5a2c488780635be8afc07c68522b7ea5";
