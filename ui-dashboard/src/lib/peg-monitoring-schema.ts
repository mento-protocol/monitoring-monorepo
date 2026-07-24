import { z } from "zod";

const MAX_PACKAGES = 32;
const MAX_SOURCES = 16;
const MAX_MONITORS = 8;
const MAX_TOKENS = 8;
const MAX_RENDERABLE_UNIX_SECONDS = 8_640_000_000_000;

const policyVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const asset = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)+$/);
const id = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const provider = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
const currency = z
  .string()
  .min(2)
  .max(12)
  .regex(/^[A-Z][A-Z0-9]*$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const timestamp = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_RENDERABLE_UNIX_SECONDS);
const number = z.number().finite().nonnegative();
const integer = z.number().int().nonnegative();
const uint256 = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine(
    (value) => BigInt(value) <= BigInt(2) ** BigInt(256) - BigInt(1),
    "must fit uint256",
  );
const positiveUint256 = uint256.refine((value) => BigInt(value) > BigInt(0));

const policy = z
  .object({
    target: z.number().finite().positive(),
    warnDeviationBps: z.number().finite().positive().max(10_000),
    criticalDeviationBps: z.number().finite().positive().max(10_000),
    premiumWarnBps: z.number().finite().positive().max(10_000),
    warnSustainSeconds: z.number().int().min(60).max(86_400),
    criticalSustainSeconds: z.number().int().min(60).max(86_400),
    durationQuantile: z.number().finite().gt(0).lt(1),
    minimumCoverageFraction: z.number().finite().gt(0).max(1),
    blindConsecutivePolls: z.number().int().positive().max(1_000),
    permanentlyDeadSeconds: z.number().int().min(86_400).max(31_536_000),
    structuralWarnFraction: z.number().finite().gt(0).max(1),
    freshnessGraceSeconds: z.number().int().min(60).max(3_600),
    deepVenueSource: id,
  })
  .strict();
const structural = z
  .object({
    blind: z.boolean(),
    blindConsecutivePolls: integer.max(1_000),
    structuralSaturation: number.nullable(),
    structuralQuerySaturated: z.boolean(),
    indexedPoolReachable: z.boolean(),
    counterpartyCount: integer,
  })
  .strict();
const breaker = z
  .object({
    id: z.string().min(1).max(256).regex(/^\S+$/),
    address,
    enabled: z.boolean(),
    kind: z.enum(["MEDIAN_DELTA", "VALUE_DELTA"]),
    status: z.enum(["OK", "TRIPPED"]),
    tradingMode: integer,
    effectiveRateChangeThreshold: positiveUint256,
    referenceValue: uint256.nullable(),
    lastMedianRate: uint256.nullable(),
    thresholdScale: z.literal("fixidity-1e24"),
    lastUpdatedAt: timestamp.nullable(),
    lastStatusUpdatedAt: timestamp,
  })
  .strict();
const monitor = z
  .object({
    chainId: z.number().int().positive(),
    poolAddress: address,
    rateFeedId: address,
    monitoredTokenAddress: address,
    indexedPoolReachable: z.boolean(),
    structuralSaturation: number.nullable(),
    structuralQuerySaturated: z.boolean(),
    counterpartyCount: integer,
    breaker: breaker.nullable(),
  })
  .strict();
const sourcePolicy = z
  .object({
    referenceSizeCap: z.number().finite().positive(),
    pollIntervalSeconds: z.number().int().min(15).max(3_600),
    staleAfterSeconds: z.number().int().positive().max(86_400),
    spreadEnvelopeBps: number.max(10_000),
    conversionErrorBps: number.max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.staleAfterSeconds < value.pollIntervalSeconds * 2)
      context.addIssue({
        code: "custom",
        path: ["staleAfterSeconds"],
        message: "must allow two poll intervals",
      });
  });
const source = z
  .object({
    id,
    provider,
    pair: z.string().min(1).max(80).regex(/^\S+$/),
    baseCurrency: currency,
    quoteCurrency: currency,
    registryRole: z.enum(["primary", "secondary", "display"]),
    authority: z.enum(["deep", "secondary", "display"]),
    convertVia: z
      .object({
        chainId: z.number().int().positive(),
        rateFeedId: address,
        fromCurrency: currency,
        toCurrency: currency,
      })
      .strict()
      .nullable(),
    policy: sourcePolicy,
    listingState: z.enum(["listed", "halted", "absent"]).nullable(),
    listingCheckedAt: timestamp.nullable(),
    healthy: z.boolean(),
    venueState: z
      .enum([
        "ok",
        "wide",
        "one_sided_bid",
        "one_sided_ask",
        "evacuated",
        "halted",
      ])
      .nullable(),
    observationAt: timestamp.nullable(),
    fetchedAt: timestamp.nullable(),
    lastTradeAt: timestamp.nullable(),
    executablePrice: z.number().finite().positive().nullable(),
    filledFraction: z.number().finite().min(0).max(1).nullable(),
    capped: z.boolean().nullable(),
    referenceSize: z.number().finite().positive().nullable(),
    bid: z.number().finite().positive().nullable(),
    ask: z.number().finite().positive().nullable(),
    spreadBps: number.nullable(),
    deviationBps: number.nullable(),
    premiumBps: number.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.listingState === null) !== (value.listingCheckedAt === null))
      context.addIssue({
        code: "custom",
        path: ["listingCheckedAt"],
        message: "must pair with listingState",
      });
    if (
      !value.healthy &&
      value.observationAt !== null &&
      value.fetchedAt === null
    )
      context.addIssue({
        code: "custom",
        path: ["fetchedAt"],
        message: "source evidence must be complete",
      });
    if (
      value.convertVia !== null &&
      value.convertVia.fromCurrency !== value.quoteCurrency
    )
      context.addIssue({
        code: "custom",
        path: ["convertVia"],
        message: "must match source quote",
      });
    if (
      value.convertVia !== null &&
      value.convertVia.toCurrency === value.convertVia.fromCurrency
    )
      context.addIssue({
        code: "custom",
        path: ["convertVia", "toCurrency"],
        message: "conversion currencies must differ",
      });
  });

type AssetPackageInput = {
  peg: string;
  tokenRefs: Array<{ chainId: number; address: string }>;
  policy: z.infer<typeof policy>;
  structural: z.infer<typeof structural>;
  monitors: z.infer<typeof monitor>[];
  sources: z.infer<typeof source>[];
};

function validatePolicyRelationships(
  value: AssetPackageInput,
  context: z.RefinementCtx,
): void {
  if (value.policy.criticalDeviationBps <= value.policy.warnDeviationBps)
    context.addIssue({
      code: "custom",
      path: ["policy", "criticalDeviationBps"],
      message: "must exceed warning",
    });
  if (value.policy.criticalSustainSeconds < value.policy.warnSustainSeconds)
    context.addIssue({
      code: "custom",
      path: ["policy", "criticalSustainSeconds"],
      message: "must cover warning",
    });
  if (value.policy.permanentlyDeadSeconds <= value.policy.freshnessGraceSeconds)
    context.addIssue({
      code: "custom",
      path: ["policy", "permanentlyDeadSeconds"],
      message: "must exceed freshness grace",
    });
  const deep = value.sources.filter((item) => item.authority === "deep");
  if (deep.length !== 1 || deep[0]?.id !== value.policy.deepVenueSource)
    context.addIssue({
      code: "custom",
      path: ["policy", "deepVenueSource"],
      message: "must name the one deep source",
    });
  if (
    value.structural.blindConsecutivePolls > value.policy.blindConsecutivePolls
  )
    context.addIssue({
      code: "custom",
      path: ["structural", "blindConsecutivePolls"],
      message: "must not exceed policy threshold",
    });
}

function validateSourceTopology(
  value: AssetPackageInput,
  context: z.RefinementCtx,
): void {
  const sourceIds = new Set<string>();
  value.sources.forEach((source, index) => {
    if (sourceIds.has(source.id))
      context.addIssue({
        code: "custom",
        path: ["sources", index, "id"],
        message: "duplicate source id",
      });
    sourceIds.add(source.id);
    if (source.authority === "deep" && source.registryRole !== "primary")
      context.addIssue({
        code: "custom",
        path: ["sources", index, "registryRole"],
        message: "deep authority requires primary topology",
      });
    if (source.registryRole === "display" && source.authority !== "display")
      context.addIssue({
        code: "custom",
        path: ["sources", index, "authority"],
        message: "display topology requires display authority",
      });
    if (source.convertVia !== null) {
      if (source.convertVia.toCurrency !== value.peg)
        context.addIssue({
          code: "custom",
          path: ["sources", index, "convertVia", "toCurrency"],
          message: "conversion must end in asset peg",
        });
      if (
        !value.tokenRefs.some(
          ({ chainId }) => chainId === source.convertVia!.chainId,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["sources", index, "convertVia", "chainId"],
          message: "conversion chain must match token reference",
        });
    } else if (source.quoteCurrency !== value.peg)
      context.addIssue({
        code: "custom",
        path: ["sources", index, "convertVia"],
        message: "non-peg quote requires conversion",
      });
  });
}

function validateTokenAndMonitorTopology(
  value: AssetPackageInput,
  context: z.RefinementCtx,
): void {
  const tokenRefs = new Set<string>();
  value.tokenRefs.forEach((tokenRef, index) => {
    const identity = `${tokenRef.chainId}:${tokenRef.address}`;
    if (tokenRefs.has(identity))
      context.addIssue({
        code: "custom",
        path: ["tokenRefs", index],
        message: "duplicate token reference",
      });
    tokenRefs.add(identity);
  });
  const monitorIds = new Set<string>();
  value.monitors.forEach((monitor, index) => {
    const identity = `${monitor.chainId}:${monitor.poolAddress}:${monitor.rateFeedId}:${monitor.monitoredTokenAddress}`;
    if (monitorIds.has(identity))
      context.addIssue({
        code: "custom",
        path: ["monitors", index],
        message: "duplicate monitor identity",
      });
    monitorIds.add(identity);
    if (
      !value.tokenRefs.some(
        (token) =>
          token.chainId === monitor.chainId &&
          token.address === monitor.monitoredTokenAddress,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["monitors", index, "monitoredTokenAddress"],
        message: "monitor token must match token reference on its chain",
      });
  });
}

const assetPackage = z
  .object({
    asset,
    peg: currency,
    coverageClass: z.literal("cex-book+indexed-pool"),
    tokenRefs: z
      .array(
        z.object({ chainId: z.number().int().positive(), address }).strict(),
      )
      .min(1)
      .max(MAX_TOKENS),
    policy,
    structural,
    monitors: z.array(monitor).min(1).max(MAX_MONITORS),
    sources: z.array(source).min(1).max(MAX_SOURCES),
  })
  .strict()
  .superRefine((value, context) => {
    validatePolicyRelationships(value, context);
    validateTokenAndMonitorTopology(value, context);
    validateSourceTopology(value, context);
  });

export const PegMonitoringResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvedActivePolicyVersion: policyVersion,
    producedPolicyVersion: policyVersion,
    policySlot: z.enum(["active", "previous"]),
    producedAt: timestamp,
    rolloverAckExpectedSeconds: z.number().int().min(30).max(3_600),
    packages: z.array(assetPackage).min(1).max(MAX_PACKAGES),
  })
  .strict()
  .superRefine((value, context) => {
    const isActive =
      value.approvedActivePolicyVersion === value.producedPolicyVersion;
    if ((value.policySlot === "active") !== isActive)
      context.addIssue({
        code: "custom",
        path: ["policySlot"],
        message: "must match policy version equality",
      });
    const assets = new Set<string>();
    value.packages.forEach((item, index) => {
      if (assets.has(item.asset))
        context.addIssue({
          code: "custom",
          path: ["packages", index, "asset"],
          message: "duplicate asset package",
        });
      assets.add(item.asset);
    });
  });

export type PegMonitoringResponse = z.infer<typeof PegMonitoringResponseSchema>;
export type PegAssetPackage = z.infer<typeof assetPackage>;
export type PegMonitor = z.infer<typeof monitor>;
export type PegSource = z.infer<typeof source>;
