export const PEG_FAILURE_REASON_CODES = {
  rate_limited: 1,
  provider_http_error: 2,
  provider_timeout: 3,
  provider_network: 4,
  invalid_response: 5,
  stale_data: 6,
  repeated_data: 7,
  insufficient_liquidity: 8,
  market_halted: 9,
  conversion_unavailable: 10,
  conversion_error: 11,
  structural_query: 12,
  structural_missing: 13,
  structural_binding: 14,
  structural_data: 15,
  reference_size_unavailable: 16,
  unsupported_provider: 17,
  unknown: 18,
  multiple_failures: 19,
  market_unlisted: 20,
} as const;

export type PegFailureReason = keyof typeof PEG_FAILURE_REASON_CODES;

export interface PegFailureEvidence {
  reason: PegFailureReason;
  httpStatus: number | null;
}

interface MutablePegFailureState {
  failureReason: PegFailureReason | null;
  failureHttpStatus: number | null;
}

export function setPegFailure(
  state: MutablePegFailureState,
  evidence: PegFailureEvidence | null,
): void {
  state.failureReason = evidence?.reason ?? null;
  state.failureHttpStatus = evidence?.httpStatus ?? null;
}

export class PegProviderRequestError extends Error {
  readonly evidence: PegFailureEvidence;

  constructor(
    message: string,
    evidence: PegFailureEvidence,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PegProviderRequestError";
    this.evidence = evidence;
  }
}

export function providerFailureEvidence(cause: unknown): PegFailureEvidence {
  if (cause instanceof PegProviderRequestError) return cause.evidence;
  if (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.name === "TimeoutError")
  ) {
    return { reason: "provider_timeout", httpStatus: null };
  }
  if (cause instanceof TypeError) {
    return { reason: "provider_network", httpStatus: null };
  }
  return { reason: "invalid_response", httpStatus: null };
}

export function pegFailureEvidence(
  kind: string,
  cause: unknown,
): PegFailureEvidence {
  if (kind === "source_fetch") return providerFailureEvidence(cause);
  if (kind === "source_provider") {
    return { reason: "unsupported_provider", httpStatus: null };
  }
  if (kind === "source_freshness") {
    const message = cause instanceof Error ? cause.message : "";
    return {
      reason:
        message.includes("replay") || message.includes("identity bound")
          ? "repeated_data"
          : "stale_data",
      httpStatus: null,
    };
  }
  if (kind === "conversion_unavailable") {
    return { reason: "conversion_unavailable", httpStatus: null };
  }
  if (kind === "conversion") {
    return { reason: "conversion_error", httpStatus: null };
  }
  const structuralReason = STRUCTURAL_FAILURE_REASONS[kind];
  if (structuralReason !== undefined)
    return { reason: structuralReason, httpStatus: null };
  return { reason: "unknown", httpStatus: null };
}

const STRUCTURAL_FAILURE_REASONS: Partial<Record<string, PegFailureReason>> = {
  structural_query: "structural_query",
  structural_missing: "structural_missing",
  structural_binding: "structural_binding",
  structural_data: "structural_data",
};

export function failureHttpStatusLabel(httpStatus: number | null): string {
  if (httpStatus === null) return "none";
  return Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
    ? String(httpStatus)
    : "none";
}

export function failureReasonCode(reason: PegFailureReason | null): number {
  return reason === null ? 0 : PEG_FAILURE_REASON_CODES[reason];
}

export function combineFailureReasons(
  reasons: readonly (PegFailureReason | null)[],
): PegFailureReason | null {
  const distinct = new Set(reasons.filter((reason) => reason !== null));
  if (distinct.size === 0) return null;
  if (distinct.size > 1) return "multiple_failures";
  return distinct.values().next().value ?? null;
}
