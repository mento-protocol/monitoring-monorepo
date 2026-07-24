import {
  PEG_BREAKER_CONFIG_LIMIT,
  type PegBreakerConfigRow,
} from "./graphql.js";
import type { PegBreakerMetricSnapshot } from "./metrics.js";

export type PegBreakerEvidenceResult =
  | { breaker: PegBreakerMetricSnapshot | null; error: null }
  | { breaker: null; error: Error };

const UINT256_DECIMAL = /^\d{1,78}$/;

function decimal(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!UINT256_DECIMAL.test(value) || BigInt(value) >= 1n << 256n) {
    throw new Error(`${field} must be a bounded non-negative integer`);
  }
  return BigInt(value).toString();
}

function timestamp(value: string | null, field: string): number | null {
  if (value === null) return null;
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return Number(parsed);
}

function selectedConfig(
  configs: PegBreakerConfigRow[],
): PegBreakerConfigRow | null {
  if (configs.length >= PEG_BREAKER_CONFIG_LIMIT) {
    throw new Error("breaker-config query reached its bound");
  }
  const available = configs.filter(
    (config) =>
      !config.breaker.removed && config.breaker.kind !== "MARKET_HOURS",
  );
  if (available.length === 0) return null;

  const enabled = available.filter((config) => config.enabled);
  if (enabled.length === 1) return enabled[0]!;
  if (enabled.length > 1) {
    throw new Error("breaker state is ambiguous for the monitored rate feed");
  }

  const disabled = available.filter((config) => !config.enabled);
  if (disabled.length === 1) return disabled[0]!;
  throw new Error("breaker state is ambiguous for the monitored rate feed");
}

export function resolvePegBreakerEvidence(
  configs: PegBreakerConfigRow[],
): PegBreakerEvidenceResult {
  try {
    const config = selectedConfig(configs);
    if (config === null) return { breaker: null, error: null };
    if (config.breaker.kind === "MARKET_HOURS") {
      throw new Error("unsupported breaker kind");
    }
    const override = BigInt(
      decimal(config.rateChangeThreshold, "rateChangeThreshold")!,
    );
    const fallback = BigInt(
      decimal(
        config.breaker.defaultRateChangeThreshold,
        "defaultRateChangeThreshold",
      )!,
    );
    const effective = override > 0n ? override : fallback;
    if (effective === 0n)
      throw new Error("effective breaker threshold must be positive");
    const lastStatusUpdatedAt = timestamp(
      config.lastStatusUpdatedAt,
      "breaker lastStatusUpdatedAt",
    );
    if (lastStatusUpdatedAt === null) {
      throw new Error("breaker lastStatusUpdatedAt is required");
    }
    return {
      breaker: {
        id: config.id,
        address: config.breaker.address,
        enabled: config.enabled,
        kind: config.breaker.kind,
        status: config.status,
        tradingMode: config.tradingMode,
        effectiveRateChangeThreshold: effective.toString(),
        referenceValue: decimal(
          config.referenceValue,
          "breaker referenceValue",
        ),
        lastMedianRate: decimal(
          config.lastMedianRate,
          "breaker lastMedianRate",
        ),
        lastUpdatedAt: timestamp(config.lastUpdatedAt, "breaker lastUpdatedAt"),
        lastStatusUpdatedAt,
      },
      error: null,
    };
  } catch (error) {
    return {
      breaker: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
