import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,63}$/, "must be a stable lowercase identifier");

const assetSlug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,63}$/, "must be a stable lowercase asset slug");

const policyVersion = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    "must be a bounded Prometheus-label-safe version",
  );

export const PEG_POLICY_CONTENT_DIGEST_HEX_LENGTH = 32;

function canonicalizePolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePolicyValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizePolicyValue(record[key])]),
  );
}

export function pegPolicyContentDigest(
  policy: Record<string, unknown>,
): string {
  const content = Object.fromEntries(
    Object.entries(policy).filter(([key]) => key !== "version"),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalizePolicyValue(content)))
    .digest("hex")
    .slice(0, PEG_POLICY_CONTENT_DIGEST_HEX_LENGTH);
}

export function pegPolicyVersionForContent(
  prefix: string,
  policy: Record<string, unknown>,
): string {
  const version = `${prefix}-${pegPolicyContentDigest(policy)}`;
  return policyVersion.parse(version);
}

export const PEG_POLICY_MAX_ASSETS = 32;
export const PEG_POLICY_MAX_SOURCES_PER_ASSET = 16;

export const PegSourcePolicySchema = z
  .object({
    authority: z.enum(["deep", "secondary", "display"]),
    referenceSizeCap: z.number().finite().positive(),
    pollIntervalSeconds: z.number().int().min(15).max(3_600),
    staleAfterSeconds: z.number().int().positive().max(86_400),
    spreadEnvelopeBps: z.number().finite().nonnegative().max(10_000),
    conversionErrorBps: z.number().finite().nonnegative().max(10_000),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.staleAfterSeconds < source.pollIntervalSeconds * 2) {
      context.addIssue({
        code: "custom",
        path: ["staleAfterSeconds"],
        message: "must allow at least two approved poll intervals",
      });
    }
  });

const PegAssetPolicyBaseSchema = z
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
    deepVenueSource: identifier,
    sources: z.record(identifier, PegSourcePolicySchema),
  })
  .strict();

type PegAssetPolicyInput = z.infer<typeof PegAssetPolicyBaseSchema>;

function validateThresholdRelationships(
  asset: PegAssetPolicyInput,
  context: z.RefinementCtx,
): void {
  if (asset.criticalDeviationBps <= asset.warnDeviationBps) {
    context.addIssue({
      code: "custom",
      path: ["criticalDeviationBps"],
      message: "must be greater than warnDeviationBps",
    });
  }
  if (asset.criticalSustainSeconds < asset.warnSustainSeconds) {
    context.addIssue({
      code: "custom",
      path: ["criticalSustainSeconds"],
      message: "must be at least warnSustainSeconds",
    });
  }
  if (asset.permanentlyDeadSeconds <= asset.freshnessGraceSeconds) {
    context.addIssue({
      code: "custom",
      path: ["permanentlyDeadSeconds"],
      message: "must exceed freshnessGraceSeconds",
    });
  }
}

function validateSourceRelationships(
  asset: PegAssetPolicyInput,
  context: z.RefinementCtx,
): void {
  const sources = Object.entries(asset.sources);
  if (sources.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["sources"],
      message: "must declare at least one source",
    });
    return;
  }
  if (sources.length > PEG_POLICY_MAX_SOURCES_PER_ASSET) {
    context.addIssue({
      code: "custom",
      path: ["sources"],
      message: `must declare at most ${PEG_POLICY_MAX_SOURCES_PER_ASSET} sources`,
    });
  }
  const maximumPollInterval = Math.max(
    ...sources.map(([, source]) => source.pollIntervalSeconds),
  );
  if (asset.freshnessGraceSeconds < maximumPollInterval) {
    context.addIssue({
      code: "custom",
      path: ["freshnessGraceSeconds"],
      message: "must cover the slowest source poll interval",
    });
  }
  const deepSources = sources
    .filter(([, source]) => source.authority === "deep")
    .map(([sourceId]) => sourceId);
  if (deepSources.length !== 1 || deepSources[0] !== asset.deepVenueSource) {
    context.addIssue({
      code: "custom",
      path: ["deepVenueSource"],
      message: "must name the policy's single source with deep alert authority",
    });
  }
}

export const PegAssetPolicySchema = PegAssetPolicyBaseSchema.superRefine(
  (asset, context) => {
    validateThresholdRelationships(asset, context);
    validateSourceRelationships(asset, context);
  },
);

export const PegPolicyVersionSchema = z
  .object({
    version: policyVersion,
    rolloverAckExpectedSeconds: z.number().int().min(30).max(3_600),
    assets: z.record(assetSlug, PegAssetPolicySchema),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Object.keys(policy.assets).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "must declare at least one asset",
      });
    }
    if (Object.keys(policy.assets).length > PEG_POLICY_MAX_ASSETS) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: `must declare at most ${PEG_POLICY_MAX_ASSETS} assets`,
      });
    }
    const expectedSuffix = `-${pegPolicyContentDigest(policy)}`;
    if (!policy.version.endsWith(expectedSuffix)) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: `must end with the policy content digest ${expectedSuffix}`,
      });
    }
  });

export const PegPolicyBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    active: PegPolicyVersionSchema,
    previous: PegPolicyVersionSchema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.previous?.version === bundle.active.version) {
      context.addIssue({
        code: "custom",
        path: ["previous", "version"],
        message: "must differ from the active version",
      });
    }
  });

export type PegSourcePolicy = z.infer<typeof PegSourcePolicySchema>;
export type PegAssetPolicy = z.infer<typeof PegAssetPolicySchema>;
export type PegPolicyVersion = z.infer<typeof PegPolicyVersionSchema>;
export type PegPolicyBundle = z.infer<typeof PegPolicyBundleSchema>;

export function parsePegPolicyBundle(input: unknown): PegPolicyBundle {
  return PegPolicyBundleSchema.parse(input);
}
