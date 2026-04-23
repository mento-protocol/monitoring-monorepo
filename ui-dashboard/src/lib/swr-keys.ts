// Centralized SWR cache keys for the cross-network fetch hooks.
// Defined once so the Server Component fallback (`SWRConfig.fallback`)
// and the hook's `useSWR` call can't drift apart — a silent mismatch
// there means the SSR payload never hydrates into the client cache.

export const SWR_KEY_ALL_NETWORKS_DATA = "all-networks-data";
export const SWR_KEY_ORACLE_RATES = "oracle-rates-all-networks";
export const SWR_KEY_PROTOCOL_FEES = "protocol-fees-all-networks";
