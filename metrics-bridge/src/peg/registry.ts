import { readFile } from "node:fs/promises";
import { z } from "zod";

const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "Expected a lowercase 20-byte EVM address");

const chainIdSchema = z.number().int().positive();
const currencySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,11}$/, "Expected an uppercase currency code");
const sourceIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "Expected a stable lowercase source id");
const providerSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase provider id");
const pairSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^\S+$/, "Pair must not contain whitespace");
const assetSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)+$/,
    "Asset keys must be descriptive lowercase slugs, not tickers",
  );

export const pegSourceRoleSchema = z.enum(["primary", "secondary", "display"]);

export const PEG_REGISTRY_MAX_ASSETS = 32;
export const PEG_REGISTRY_MAX_SOURCES_PER_ASSET = 16;
export const PEG_REGISTRY_MAX_MONITORS_PER_ASSET = 8;
export const PEG_REGISTRY_MAX_TOKEN_REFS_PER_ASSET = 8;
export const PEG_REGISTRY_MAX_REJECTED_SOURCES_PER_ASSET = 64;

// Coverage classes are executable contracts, not free-form descriptions.
// Add a class here only with the validator and policy semantics that implement it.
export const pegCoverageClassSchema = z.enum(["cex-book+indexed-pool"]);

export const pegTokenRefSchema = z
  .object({
    chainId: chainIdSchema,
    address: evmAddressSchema,
  })
  .strict();

export const pegConversionSchema = z
  .object({
    chainId: chainIdSchema,
    rateFeedId: evmAddressSchema,
    fromCurrency: currencySchema,
    toCurrency: currencySchema,
  })
  .strict()
  .refine(({ fromCurrency, toCurrency }) => fromCurrency !== toCurrency, {
    message: "Conversion currencies must differ",
    path: ["toCurrency"],
  });

export const pegSourceSchema = z
  .object({
    id: sourceIdSchema,
    provider: providerSchema,
    pair: pairSchema,
    baseCurrency: currencySchema,
    quoteCurrency: currencySchema,
    // This role describes source topology only. Alert authority is gated policy.
    role: pegSourceRoleSchema,
    convertVia: pegConversionSchema.optional(),
  })
  .strict();

export const pegMonitorSchema = z
  .object({
    chainId: chainIdSchema,
    poolAddress: evmAddressSchema,
    rateFeedId: evmAddressSchema,
    monitoredTokenAddress: evmAddressSchema,
  })
  .strict();

export const rejectedPegSourceSchema = z
  .object({
    provider: providerSchema,
    pair: pairSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const pegAssetBaseSchema = z
  .object({
    peg: currencySchema,
    tokenRefs: z
      .array(pegTokenRefSchema)
      .min(1)
      .max(PEG_REGISTRY_MAX_TOKEN_REFS_PER_ASSET),
    sources: z
      .array(pegSourceSchema)
      .min(1)
      .max(PEG_REGISTRY_MAX_SOURCES_PER_ASSET),
    monitors: z
      .array(pegMonitorSchema)
      .min(1)
      .max(PEG_REGISTRY_MAX_MONITORS_PER_ASSET),
    coverageClass: pegCoverageClassSchema,
    rejectedSources: z
      .array(rejectedPegSourceSchema)
      .max(PEG_REGISTRY_MAX_REJECTED_SOURCES_PER_ASSET),
  })
  .strict();

type PegAssetInput = z.infer<typeof pegAssetBaseSchema>;
type RegistryIssue = { message: string; path: PropertyKey[] };

function tokenRefIssues(asset: PegAssetInput): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const identities = new Set<string>();
  asset.tokenRefs.forEach((tokenRef, index) => {
    const identity = `${tokenRef.chainId}:${tokenRef.address}`;
    if (identities.has(identity)) {
      issues.push({
        message: "Duplicate token reference",
        path: ["tokenRefs", index],
      });
    }
    identities.add(identity);
  });
  return issues;
}

function conversionIssues(
  asset: PegAssetInput,
  sourceIndex: number,
): RegistryIssue[] {
  const source = asset.sources[sourceIndex]!;
  const conversion = source.convertVia;
  if (!conversion) {
    return source.quoteCurrency === asset.peg
      ? []
      : [
          {
            message:
              "A source quoted outside the peg currency requires a conversion",
            path: ["sources", sourceIndex, "convertVia"],
          },
        ];
  }

  const issues: RegistryIssue[] = [];
  if (conversion.fromCurrency !== source.quoteCurrency) {
    issues.push({
      message: "Conversion must start from the source quote currency",
      path: ["sources", sourceIndex, "convertVia", "fromCurrency"],
    });
  }
  if (conversion.toCurrency !== asset.peg) {
    issues.push({
      message: "Conversion must end in the asset peg currency",
      path: ["sources", sourceIndex, "convertVia", "toCurrency"],
    });
  }
  if (!asset.tokenRefs.some(({ chainId }) => chainId === conversion.chainId)) {
    issues.push({
      message: "Conversion chain must match an asset token reference",
      path: ["sources", sourceIndex, "convertVia", "chainId"],
    });
  }
  return issues;
}

function sourceIssues(asset: PegAssetInput): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const ids = new Set<string>();
  asset.sources.forEach((source, index) => {
    if (ids.has(source.id)) {
      issues.push({
        message: `Duplicate source id: ${source.id}`,
        path: ["sources", index, "id"],
      });
    }
    ids.add(source.id);
    issues.push(...conversionIssues(asset, index));
  });
  return issues;
}

function monitorIssues(asset: PegAssetInput): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const identities = new Set<string>();
  asset.monitors.forEach((monitor, index) => {
    const identity = [
      monitor.chainId,
      monitor.poolAddress,
      monitor.rateFeedId,
      monitor.monitoredTokenAddress,
    ].join(":");
    if (identities.has(identity)) {
      issues.push({
        message: "Duplicate monitor identity",
        path: ["monitors", index],
      });
    }
    identities.add(identity);

    const tokenMatches = asset.tokenRefs.some(
      (tokenRef) =>
        tokenRef.chainId === monitor.chainId &&
        tokenRef.address === monitor.monitoredTokenAddress,
    );
    if (!tokenMatches) {
      issues.push({
        message: "Monitor token must match a token reference on its chain",
        path: ["monitors", index, "monitoredTokenAddress"],
      });
    }
  });
  return issues;
}

export const pegAssetSchema = pegAssetBaseSchema.superRefine(
  (asset, context) => {
    const issues = [
      ...tokenRefIssues(asset),
      ...sourceIssues(asset),
      ...monitorIssues(asset),
    ];
    issues.forEach((issue) => context.addIssue({ code: "custom", ...issue }));
  },
);

export const pegRegistrySchema = z
  .record(assetSlugSchema, pegAssetSchema)
  .refine((assets) => Object.keys(assets).length > 0, {
    message: "Peg registry must contain at least one asset",
  })
  .refine((assets) => Object.keys(assets).length <= PEG_REGISTRY_MAX_ASSETS, {
    message: `Peg registry must contain at most ${PEG_REGISTRY_MAX_ASSETS} assets`,
  });

export type PegSourceRole = z.infer<typeof pegSourceRoleSchema>;
export type PegCoverageClass = z.infer<typeof pegCoverageClassSchema>;
export type PegTokenRef = z.infer<typeof pegTokenRefSchema>;
export type PegConversion = z.infer<typeof pegConversionSchema>;
export type PegSource = z.infer<typeof pegSourceSchema>;
export type PegMonitor = z.infer<typeof pegMonitorSchema>;
export type RejectedPegSource = z.infer<typeof rejectedPegSourceSchema>;
export type PegAsset = z.infer<typeof pegAssetSchema>;
export type PegRegistry = z.infer<typeof pegRegistrySchema>;

export type PegRegistryAsset = PegAsset;
export type PegRegistrySource = PegSource;
export type PegRegistryMonitor = PegMonitor;

export function parsePegRegistry(input: unknown): PegRegistry {
  return pegRegistrySchema.parse(input);
}

const defaultRegistryUrl = new URL("../../peg-registry.json", import.meta.url);

export async function loadPegRegistry(
  registryUrl: URL = defaultRegistryUrl,
): Promise<PegRegistry> {
  const contents = await readFile(registryUrl, "utf8");
  return parsePegRegistry(JSON.parse(contents) as unknown);
}
