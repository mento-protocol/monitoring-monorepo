import type { Pool } from "@/lib/types";

export function TokenDecimalsTrustNotice({
  pool,
  thresholdsLoading,
  thresholdsError,
}: {
  pool: Pool | null;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
}) {
  if (!pool) return null;

  if (thresholdsLoading && pool.tokenDecimalsKnown !== true) {
    return (
      <p
        role="status"
        className="mb-4 rounded-md border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300"
      >
        Checking token decimal metadata before trusting token amount displays.
      </p>
    );
  }

  if (thresholdsError) {
    return (
      <p
        role="alert"
        className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        Token decimal metadata is unavailable. Token amounts may use fallback
        decimals until the trust query recovers.
      </p>
    );
  }

  if (pool.tokenDecimalsKnown !== true) {
    return (
      <p
        role="alert"
        className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        Token decimals are unverified for this pool. Token amount displays may
        be inaccurate until the indexer confirms on-chain decimals.
      </p>
    );
  }

  return null;
}
