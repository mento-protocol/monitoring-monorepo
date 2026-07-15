import { z } from "zod/mini";
import { getRedis } from "@/lib/redis";

const INTEGRATION_PROBES_LATEST_KEY = "integration-probes:latest";

const StatusSchema = z.enum([
  "pass",
  "partial",
  "fail",
  "unsupported",
  "needs_key",
  "no_liquidity",
  "rate_limited",
  "budget_exhausted",
  "error",
]);

const EvidenceSchema = z.object({
  type: z.enum(["router-address", "pool-address", "source-label"]),
  value: z.string(),
  path: z.string(),
});

const NullableStringSchema = z.nullable(z.string());
const NullableNumberSchema = z.nullable(z.number());

const VolumeSignalSchema = z.pipe(
  z.optional(
    z.nullable(
      z.object({
        window: z.literal("30d"),
        category: z.enum([
          "dex-aggregator",
          "bridge-aggregator",
          "direct-bridge",
          "official-stats",
        ]),
        valueUsd: NullableNumberSchema,
        sourceLabel: z.string(),
        sourceUrl: NullableStringSchema,
        sourceProtocol: NullableStringSchema,
        note: NullableStringSchema,
      }),
    ),
  ),
  z.transform((value) => value ?? null),
);

const NullishNumberSchema = z.pipe(
  z.optional(NullableNumberSchema),
  z.transform((value) => value ?? null),
);
const NullishStringSchema = z.pipe(
  z.optional(NullableStringSchema),
  z.transform((value) => value ?? null),
);

const PairResultSchema = z.object({
  pairId: z.string(),
  poolId: z.string(),
  direction: z.enum(["base-to-usdm", "usdm-to-base"]),
  sellSymbol: z.string(),
  buySymbol: z.string(),
  status: StatusSchema,
  evidence: z.array(EvidenceSchema),
  sourceLabels: z.array(z.string()),
  txTarget: NullableStringSchema,
  downstreamProvider: NullableStringSchema,
  routeVariant: NullishStringSchema,
  routeAmountUsd: NullishStringSchema,
  attemptCount: NullishNumberSchema,
  requestUrl: NullableStringSchema,
  httpStatus: NullishNumberSchema,
  latencyMs: NullishNumberSchema,
  responsePreview: NullishStringSchema,
  error: NullableStringSchema,
});

const ChainResultSchema = z.object({
  chainId: z.number(),
  chainSlug: z.string(),
  chainLabel: z.string(),
  status: StatusSchema,
  pairCoverage: z.object({ passed: z.number(), total: z.number() }),
  blockingReason: NullableStringSchema,
  nextStep: NullableStringSchema,
  pairs: z.array(PairResultSchema),
});

const AggregatorSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["dex", "cross_chain", "meta", "excluded"]),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  volumeSignal: VolumeSignalSchema,
  credentialEnv: z.array(z.string()),
  researchNote: z.string(),
  chains: z.array(ChainResultSchema),
});

const ChainConfigSchema = z.object({
  chainId: z.number(),
  chainSlug: z.string(),
  chainLabel: z.string(),
  routerAddresses: z.array(z.string()),
  poolAddresses: z.array(z.string()),
  pairs: z.array(
    z.object({
      id: z.string(),
      chainId: z.number(),
      poolId: z.string(),
      poolAddress: z.string(),
      poolSource: z.string(),
      base: z.object({
        symbol: z.string(),
        address: z.string(),
        decimals: z.number(),
      }),
      quote: z.object({
        symbol: z.string(),
        address: z.string(),
        decimals: z.number(),
      }),
    }),
  ),
});

export const IntegrationProbeSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  amountUsd: z.string(),
  takerAddress: z.string(),
  pairSource: z.object({
    kind: z.enum(["hasura", "contracts-fallback"]),
    hasuraUrlConfigured: z.boolean(),
    note: z.string(),
  }),
  chains: z.array(ChainConfigSchema),
  aggregators: z.array(AggregatorSchema),
  summary: z.object({
    aggregators: z.number(),
    chainChecks: z.number(),
    passingChainChecks: z.number(),
    partialChainChecks: z._default(z.optional(z.number()), 0),
    failingChainChecks: z.number(),
    needsKeyChainChecks: z.number(),
    unsupportedChainChecks: z.number(),
  }),
});

export type IntegrationProbeSnapshot = z.infer<
  typeof IntegrationProbeSnapshotSchema
>;
export type IntegrationProbeAggregator =
  IntegrationProbeSnapshot["aggregators"][number];
export type IntegrationProbeChain =
  IntegrationProbeAggregator["chains"][number];
export type IntegrationProbeStatus = z.infer<typeof StatusSchema>;

export async function getIntegrationProbeSnapshot(): Promise<{
  snapshot: IntegrationProbeSnapshot | null;
  error: string | null;
}> {
  try {
    const raw = await getRedis().get<unknown>(INTEGRATION_PROBES_LATEST_KEY);
    if (raw == null) return { snapshot: null, error: null };
    const parsed =
      typeof raw === "string"
        ? JSON.parse(raw)
        : (raw as Record<string, unknown>);
    const result = IntegrationProbeSnapshotSchema.safeParse(parsed);
    if (!result.success) {
      return {
        snapshot: null,
        error: "Stored integration snapshot is invalid.",
      };
    }
    return { snapshot: result.data, error: null };
  } catch (error) {
    return {
      snapshot: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
