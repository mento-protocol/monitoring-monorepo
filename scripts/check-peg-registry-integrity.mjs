#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_REGISTRY_PATH = resolve(
  REPO_ROOT,
  "metrics-bridge/peg-registry.json",
);
const DEFAULT_POLICY_PATH = resolve(
  REPO_ROOT,
  "alerts/rules/peg-thresholds.json",
);
const POLICY_REPO_PATH = "alerts/rules/peg-thresholds.json";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{2,63}$/;
const COVERAGE_CLASS = "cex-book+indexed-pool";
const SUPPORTED_CEX_PROVIDERS = new Set(["bitvavo", "kraken"]);
const MAX_ASSETS = 32;
const MAX_SOURCES_PER_ASSET = 16;
const MAX_TOKEN_REFS_PER_ASSET = 8;
const MAX_MONITORS_PER_ASSET = 8;
const MAX_REJECTED_SOURCES_PER_ASSET = 64;
const POLICY_SOURCE_NUMBER_FIELDS = [
  "referenceSizeCap",
  "pollIntervalSeconds",
  "staleAfterSeconds",
  "listingAbsentConsecutiveChecks",
  "spreadEnvelopeBps",
  "conversionErrorBps",
];
const POLICY_AUTHORITIES = new Set(["deep", "secondary", "display"]);
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const POLICY_VERSION_DIGEST_PATTERN = /-([0-9a-f]{32})$/;
const LEGACY_LISTING_ABSENT_CONSECUTIVE_CHECKS_VERSION =
  "europ-2026-07-22-v1-a69b99aad61649957a2639dc8348b05f";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recursivelySortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, recursivelySortObjectKeys(value[key])]),
  );
}

export function pegPolicyVersionDigest(policyVersion) {
  if (!isRecord(policyVersion)) return null;
  const content = Object.fromEntries(
    Object.entries(policyVersion).filter(([key]) => key !== "version"),
  );
  return createHash("sha256")
    .update(JSON.stringify(recursivelySortObjectKeys(content)))
    .digest("hex")
    .slice(0, 32);
}

function policyVersionFingerprint(policyVersion) {
  return JSON.stringify(recursivelySortObjectKeys(policyVersion));
}

export function validatePegPolicyLineage(basePolicy, policy) {
  const errors = [];
  if (!isRecord(basePolicy?.active) || !isRecord(policy?.active)) {
    return ["policy lineage: base and candidate must contain active versions"];
  }

  const baseActive = basePolicy.active;
  const nextActive = policy.active;
  const sameActiveVersion = baseActive.version === nextActive.version;
  if (!sameActiveVersion) {
    if (basePolicy.previous !== null) {
      errors.push(
        `policy.active: rollover ${printable(baseActive.version)} -> ${printable(nextActive.version)} requires ACK cleanup of the retained predecessor before another active rollover`,
      );
      return errors;
    }
    if (
      !isRecord(policy.previous) ||
      policyVersionFingerprint(policy.previous) !==
        policyVersionFingerprint(baseActive)
    ) {
      errors.push(
        `policy.previous: active rollover ${printable(baseActive.version)} -> ${printable(nextActive.version)} must retain the complete prior active version`,
      );
    }
    return errors;
  }

  if (
    policyVersionFingerprint(baseActive) !==
    policyVersionFingerprint(nextActive)
  ) {
    errors.push(
      `policy.active: version ${printable(nextActive.version)} changed content in place`,
    );
  }

  const basePrevious = isRecord(basePolicy.previous)
    ? basePolicy.previous
    : null;
  const nextPrevious = isRecord(policy.previous) ? policy.previous : null;
  if (basePrevious === null && nextPrevious !== null) {
    errors.push(
      `policy.previous: version ${printable(nextActive.version)} reintroduced a retained predecessor without an active rollover`,
    );
  } else if (
    basePrevious !== null &&
    nextPrevious !== null &&
    policyVersionFingerprint(basePrevious) !==
      policyVersionFingerprint(nextPrevious)
  ) {
    errors.push(
      `policy.previous: version ${printable(nextActive.version)} changed its retained predecessor in place`,
    );
  }
  return errors;
}

function validatePolicyVersionIdentity(version, path, errors) {
  if (
    typeof version.version !== "string" ||
    !POLICY_VERSION_PATTERN.test(version.version)
  ) {
    errors.push(
      `${path}.version: expected at most 64 lowercase Prometheus-safe characters`,
    );
    return;
  }
  const suffix = POLICY_VERSION_DIGEST_PATTERN.exec(version.version)?.[1];
  const expected = pegPolicyVersionDigest(version);
  if (suffix === undefined) {
    errors.push(
      `${path}.version: must end with the first 32 lowercase hex characters of the SHA-256 policy-content digest`,
    );
  } else if (suffix !== expected) {
    errors.push(
      `${path}.version: digest suffix ${suffix} does not match policy content ${expected}`,
    );
  }
}

function keysWithinLimit(record, limit) {
  const keys = Object.keys(record);
  return { count: keys.length, keys: keys.slice(0, limit).sort() };
}

function printable(value) {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function validateAddress(errors, path, value) {
  if (typeof value === "string" && EVM_ADDRESS.test(value)) return true;
  errors.push(
    `${path}: expected a lowercase 20-byte EVM address, received ${printable(value)}`,
  );
  return false;
}

function validateChain(state, path, chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    state.errors.push(
      `${path}: expected a positive safe-integer chainId, received ${printable(chainId)}`,
    );
    return false;
  }
  if (!state.authority.hasChain(chainId)) {
    state.errors.push(`${path}: chain ${chainId} is absent from Mento config`);
    return false;
  }
  return true;
}

function contractEntries(state, chainId) {
  if (!state.contractEntriesByChain.has(chainId)) {
    state.contractEntriesByChain.set(
      chainId,
      state.authority.contractEntries(chainId),
    );
  }
  return state.contractEntriesByChain.get(chainId);
}

function knownFeeds(state, chainId) {
  if (!state.feedsByChain.has(chainId)) {
    state.feedsByChain.set(
      chainId,
      state.authority.knownRateFeedsByChain(chainId),
    );
  }
  return state.feedsByChain.get(chainId);
}

function canonicalToken(state, chainId, address) {
  return contractEntries(state, chainId).find(
    (entry) => entry.type === "token" && entry.address === address,
  );
}

function validateTokenRefs(asset, context, state) {
  if (!Array.isArray(asset.tokenRefs) || asset.tokenRefs.length === 0) {
    state.errors.push(`${context.path}.tokenRefs: expected a non-empty array`);
    return;
  }
  if (asset.tokenRefs.length > MAX_TOKEN_REFS_PER_ASSET) {
    state.errors.push(
      `${context.path}.tokenRefs: expected at most ${MAX_TOKEN_REFS_PER_ASSET}, found ${asset.tokenRefs.length}`,
    );
  }

  const seenChains = new Set();
  const seenIdentities = new Set();
  asset.tokenRefs
    .slice(0, MAX_TOKEN_REFS_PER_ASSET)
    .forEach((tokenRef, index) => {
      const path = `${context.path}.tokenRefs[${index}]`;
      if (!isRecord(tokenRef)) {
        state.errors.push(`${path}: expected an object`);
        return;
      }
      const chainOk = validateChain(state, `${path}.chainId`, tokenRef.chainId);
      const addressOk = validateAddress(
        state.errors,
        `${path}.address`,
        tokenRef.address,
      );
      if (chainOk && seenChains.has(tokenRef.chainId)) {
        state.errors.push(
          `${path}: duplicate tokenRef chain ${tokenRef.chainId} for asset "${context.slug}"`,
        );
      }
      seenChains.add(tokenRef.chainId);
      if (!chainOk || !addressOk) return;

      const identity = `${tokenRef.chainId}:${tokenRef.address}`;
      if (seenIdentities.has(identity)) {
        state.errors.push(`${path}: duplicate token identity ${identity}`);
      }
      seenIdentities.add(identity);

      const token = canonicalToken(state, tokenRef.chainId, tokenRef.address);
      if (!token) {
        state.errors.push(
          `${path}: token ${tokenRef.address} is not a canonical token on chain ${tokenRef.chainId}`,
        );
        return;
      }
      context.tokens.set(identity, token);

      const owner = state.tokenOwners.get(identity);
      if (owner && owner !== context.slug) {
        state.errors.push(
          `${path}: token ${identity} is claimed by both "${owner}" and "${context.slug}"; remove the stale asset alias`,
        );
      } else {
        state.tokenOwners.set(identity, context.slug);
      }
    });
}

function validateSourcePair(source, path, context, state) {
  if (
    typeof source.baseCurrency !== "string" ||
    typeof source.quoteCurrency !== "string" ||
    typeof source.pair !== "string"
  ) {
    state.errors.push(
      `${path}: baseCurrency, quoteCurrency, and pair must be strings`,
    );
    return;
  }
  const delimiter = source.provider === "bitvavo" ? "-" : "/";
  const expected = `${source.baseCurrency}${delimiter}${source.quoteCurrency}`;
  if (source.pair !== expected) {
    state.errors.push(
      `${path}.pair: ${printable(source.pair)} is a stale or mismatched ${printable(source.provider)} alias; expected ${printable(expected)}`,
    );
  }

  const tokenSymbols = new Set(
    [...context.tokens.values()].map((token) => token.canonicalName),
  );
  if (
    tokenSymbols.size > 0 &&
    (tokenSymbols.size !== 1 || !tokenSymbols.has(source.baseCurrency))
  ) {
    state.errors.push(
      `${path}.baseCurrency: ${printable(source.baseCurrency)} does not match canonical token symbol(s) ${[...tokenSymbols].sort().join(", ")}`,
    );
  }
}

function validateConversion(source, path, context, state) {
  const conversion = source.convertVia;
  if (conversion === undefined) {
    if (
      typeof source.quoteCurrency === "string" &&
      source.quoteCurrency !== context.asset.peg
    ) {
      state.errors.push(
        `${path}.convertVia: required because ${source.quoteCurrency} differs from peg ${context.asset.peg}`,
      );
    }
    return;
  }
  if (!isRecord(conversion)) {
    state.errors.push(`${path}.convertVia: expected an object`);
    return;
  }

  const conversionPath = `${path}.convertVia`;
  const chainOk = validateChain(
    state,
    `${conversionPath}.chainId`,
    conversion.chainId,
  );
  const feedOk = validateAddress(
    state.errors,
    `${conversionPath}.rateFeedId`,
    conversion.rateFeedId,
  );
  if (conversion.fromCurrency !== source.quoteCurrency) {
    state.errors.push(
      `${conversionPath}.fromCurrency: expected source quote currency ${printable(source.quoteCurrency)}, received ${printable(conversion.fromCurrency)}`,
    );
  }
  if (conversion.toCurrency !== context.asset.peg) {
    state.errors.push(
      `${conversionPath}.toCurrency: expected peg currency ${printable(context.asset.peg)}, received ${printable(conversion.toCurrency)}`,
    );
  }
  if (!chainOk) return;

  state.sortedOraclesChains.add(conversion.chainId);
  const chainHasToken = [...context.tokens.values()].some(
    (token) => token.chainId === conversion.chainId,
  );
  if (!chainHasToken) {
    state.errors.push(
      `${conversionPath}.chainId: chain ${conversion.chainId} has no tokenRef for asset "${context.slug}"`,
    );
  }
  if (!feedOk) return;

  const pair = knownFeeds(state, conversion.chainId).get(conversion.rateFeedId);
  const expectedPair = `${conversion.toCurrency}/${conversion.fromCurrency}`;
  if (pair === undefined) {
    state.errors.push(
      `${conversionPath}.rateFeedId: feed ${conversion.rateFeedId} is unknown on chain ${conversion.chainId}`,
    );
  } else if (pair !== expectedPair) {
    state.errors.push(
      `${conversionPath}.rateFeedId: feed pair ${printable(pair)} does not match required conversion pair ${printable(expectedPair)}`,
    );
  }
}

function validateSources(asset, context, state) {
  if (!Array.isArray(asset.sources) || asset.sources.length === 0) {
    state.errors.push(`${context.path}.sources: expected a non-empty array`);
    return;
  }
  if (asset.sources.length > MAX_SOURCES_PER_ASSET) {
    state.errors.push(
      `${context.path}.sources: expected at most ${MAX_SOURCES_PER_ASSET}, found ${asset.sources.length}`,
    );
  }

  asset.sources.slice(0, MAX_SOURCES_PER_ASSET).forEach((source, index) => {
    const path = `${context.path}.sources[${index}]`;
    if (!isRecord(source)) {
      state.errors.push(`${path}: expected an object`);
      return;
    }
    if (typeof source.id !== "string" || !SOURCE_ID.test(source.id)) {
      state.errors.push(
        `${path}.id: expected a stable lowercase source id, received ${printable(source.id)}`,
      );
    } else if (context.sources.has(source.id)) {
      state.errors.push(`${path}.id: duplicate source id "${source.id}"`);
    } else {
      context.sources.set(source.id, source);
    }
    if (!SUPPORTED_CEX_PROVIDERS.has(source.provider)) {
      state.errors.push(
        `${path}.provider: unsupported Phase-2 adapter ${printable(source.provider)}; expected bitvavo or kraken`,
      );
    }
    validateSourcePair(source, path, context, state);
    validateConversion(source, path, context, state);
  });
}

function validateMonitor(monitor, path, context, state) {
  if (!isRecord(monitor)) {
    state.errors.push(`${path}: expected an object`);
    return null;
  }
  const chainOk = validateChain(state, `${path}.chainId`, monitor.chainId);
  const poolOk = validateAddress(
    state.errors,
    `${path}.poolAddress`,
    monitor.poolAddress,
  );
  const feedOk = validateAddress(
    state.errors,
    `${path}.rateFeedId`,
    monitor.rateFeedId,
  );
  const tokenOk = validateAddress(
    state.errors,
    `${path}.monitoredTokenAddress`,
    monitor.monitoredTokenAddress,
  );
  if (!chainOk) return null;

  state.sortedOraclesChains.add(monitor.chainId);
  const identity = `${monitor.chainId}:${monitor.monitoredTokenAddress}`;
  const token = tokenOk ? context.tokens.get(identity) : undefined;
  if (tokenOk && !token) {
    state.errors.push(
      `${path}.monitoredTokenAddress: ${monitor.monitoredTokenAddress} is not this asset's canonical SyntheticAsset tokenRef on chain ${monitor.chainId}`,
    );
  }
  if (feedOk) {
    const pair = knownFeeds(state, monitor.chainId).get(monitor.rateFeedId);
    const expectedPair = token
      ? `${token.canonicalName}/${context.asset.peg}`
      : null;
    if (pair === undefined) {
      state.errors.push(
        `${path}.rateFeedId: feed ${monitor.rateFeedId} is unknown on chain ${monitor.chainId}`,
      );
    } else if (expectedPair !== null && pair !== expectedPair) {
      state.errors.push(
        `${path}.rateFeedId: feed pair ${printable(pair)} does not bind SyntheticAsset ${printable(token.canonicalName)} to peg ${printable(context.asset.peg)}; expected ${printable(expectedPair)}`,
      );
    }
  }
  return poolOk ? `${monitor.chainId}:${monitor.poolAddress}` : null;
}

function validateMonitors(asset, context, state) {
  if (!Array.isArray(asset.monitors) || asset.monitors.length === 0) {
    state.errors.push(
      `${context.path}.monitors: coverage class ${printable(COVERAGE_CLASS)} requires at least one indexed-pool monitor`,
    );
    return;
  }
  if (asset.monitors.length > MAX_MONITORS_PER_ASSET) {
    state.errors.push(
      `${context.path}.monitors: expected at most ${MAX_MONITORS_PER_ASSET}, found ${asset.monitors.length}`,
    );
  }

  const pools = new Set();
  asset.monitors.slice(0, MAX_MONITORS_PER_ASSET).forEach((monitor, index) => {
    const path = `${context.path}.monitors[${index}]`;
    const poolIdentity = validateMonitor(monitor, path, context, state);
    if (poolIdentity === null) return;
    if (pools.has(poolIdentity)) {
      state.errors.push(
        `${path}.poolAddress: duplicate chain-scoped pool identity ${poolIdentity}`,
      );
    }
    pools.add(poolIdentity);
  });
}

function registryAssetContext(slug, asset) {
  return {
    slug,
    asset,
    path: `registry[${printable(slug)}]`,
    sources: new Map(),
    tokens: new Map(),
  };
}

function validateRegistry(registry, state) {
  if (!isRecord(registry)) {
    state.errors.push("registry: expected a slug-keyed object");
    return new Map();
  }

  const contexts = new Map();
  const registryKeys = keysWithinLimit(registry, MAX_ASSETS);
  if (registryKeys.count > MAX_ASSETS) {
    state.errors.push(
      `registry: expected at most ${MAX_ASSETS} assets, found ${registryKeys.count}`,
    );
  }
  for (const slug of registryKeys.keys) {
    const asset = registry[slug];
    if (!isRecord(asset)) {
      state.errors.push(`registry[${printable(slug)}]: expected an object`);
      continue;
    }
    const context = registryAssetContext(slug, asset);
    contexts.set(slug, context);
    if (asset.coverageClass !== COVERAGE_CLASS) {
      state.errors.push(
        `${context.path}.coverageClass: unsupported class ${printable(asset.coverageClass)}; expected ${printable(COVERAGE_CLASS)}`,
      );
    }
    if (
      Array.isArray(asset.rejectedSources) &&
      asset.rejectedSources.length > MAX_REJECTED_SOURCES_PER_ASSET
    ) {
      state.errors.push(
        `${context.path}.rejectedSources: expected at most ${MAX_REJECTED_SOURCES_PER_ASSET}, found ${asset.rejectedSources.length}`,
      );
    }
    validateTokenRefs(asset, context, state);
    validateSources(asset, context, state);
    validateMonitors(asset, context, state);
  }
  return contexts;
}

function validateSortedOracles(state) {
  for (const chainId of [...state.sortedOraclesChains].sort((a, b) => a - b)) {
    const matches = contractEntries(state, chainId).filter(
      (entry) => entry.rawName === "SortedOracles",
    );
    if (matches.length !== 1) {
      state.errors.push(
        `config chain ${chainId}: expected exactly one canonical SortedOracles contract, found ${matches.length}`,
      );
      continue;
    }
    if (matches[0].type !== "contract") {
      state.errors.push(
        `config chain ${chainId}: canonical SortedOracles entry must have contract type`,
      );
    }
    validateAddress(
      state.errors,
      `config chain ${chainId} SortedOracles.address`,
      matches[0].address,
    );
  }
}

function policyVersions(policy, errors) {
  if (!isRecord(policy)) {
    errors.push("policy: expected an object");
    return [];
  }
  const versions = [];
  if (isRecord(policy.active)) {
    versions.push(["active", policy.active]);
  } else {
    errors.push("policy.active: expected an object");
  }
  if (policy.previous !== null && policy.previous !== undefined) {
    if (isRecord(policy.previous)) {
      versions.push(["previous", policy.previous]);
    } else {
      errors.push("policy.previous: expected an object or null");
    }
  }
  return versions;
}

function compareKeys(expected, actual, path, noun, errors) {
  for (const key of [...expected].sort()) {
    if (!actual.has(key)) {
      errors.push(`${path}: missing registry ${noun} ${printable(key)}`);
    }
  }
  for (const key of [...actual].sort()) {
    if (!expected.has(key)) {
      errors.push(
        `${path}: unknown ${noun} ${printable(key)}; remove the stale alias or add it to the registry`,
      );
    }
  }
}

function validatePolicySourceFields(
  source,
  path,
  errors,
  allowLegacyThreshold,
) {
  if (!POLICY_AUTHORITIES.has(source.authority)) {
    errors.push(
      `${path}.authority: expected deep, secondary, or display; received ${printable(source.authority)}`,
    );
  }
  for (const field of POLICY_SOURCE_NUMBER_FIELDS) {
    if (allowLegacyThreshold && field === "listingAbsentConsecutiveChecks") {
      continue;
    }
    if (!Number.isFinite(source[field])) {
      errors.push(`${path}.${field}: missing or non-finite source policy`);
    }
  }
}

function validateSourcePolicyConsistency(
  registrySource,
  policySource,
  path,
  errors,
) {
  if (policySource.authority === "deep" && registrySource.role !== "primary") {
    errors.push(
      `${path}.authority: deep authority requires registry primary topology`,
    );
  }
  if (
    policySource.authority !== "display" &&
    registrySource.role === "display"
  ) {
    errors.push(
      `${path}.authority: registry display topology cannot carry alert authority`,
    );
  }
  if (
    registrySource.convertVia !== undefined &&
    !(policySource.conversionErrorBps > 0)
  ) {
    errors.push(
      `${path}.conversionErrorBps: converted source requires a positive error band`,
    );
  }
  if (
    registrySource.convertVia === undefined &&
    policySource.conversionErrorBps !== 0
  ) {
    errors.push(
      `${path}.conversionErrorBps: direct-quote source must use zero conversion error`,
    );
  }
}

function validatePolicyAsset(
  policyAsset,
  context,
  path,
  errors,
  allowLegacyListingThreshold,
) {
  if (!isRecord(policyAsset.sources)) {
    errors.push(`${path}.sources: expected an object`);
    return;
  }
  const policySourceKeys = keysWithinLimit(
    policyAsset.sources,
    MAX_SOURCES_PER_ASSET,
  );
  const policySourceIds = new Set(policySourceKeys.keys);
  if (policySourceKeys.count > MAX_SOURCES_PER_ASSET) {
    errors.push(
      `${path}.sources: expected at most ${MAX_SOURCES_PER_ASSET}, found ${policySourceKeys.count}`,
    );
  }
  if (policySourceIds.size === 0) {
    errors.push(`${path}.sources: expected at least one source`);
  }
  if (context !== null) {
    compareKeys(
      new Set(context.sources.keys()),
      policySourceIds,
      `${path}.sources`,
      "source",
      errors,
    );
  }

  const deepSources = [];
  for (const sourceId of [...policySourceIds].sort()) {
    const sourcePath = `${path}.sources[${printable(sourceId)}]`;
    const policySource = policyAsset.sources[sourceId];
    if (!isRecord(policySource)) {
      errors.push(`${sourcePath}: expected an object`);
      continue;
    }
    validatePolicySourceFields(
      policySource,
      sourcePath,
      errors,
      allowLegacyListingThreshold &&
        policySource.listingAbsentConsecutiveChecks === undefined,
    );
    if (policySource.authority === "deep") deepSources.push(sourceId);
    const registrySource = context?.sources.get(sourceId);
    if (registrySource) {
      validateSourcePolicyConsistency(
        registrySource,
        policySource,
        sourcePath,
        errors,
      );
    }
  }

  if (deepSources.length !== 1) {
    errors.push(
      `${path}.sources: expected exactly one deep venue, found ${deepSources.length}${deepSources.length > 0 ? ` (${deepSources.join(", ")})` : ""}`,
    );
  }
  if (
    deepSources.length === 1 &&
    policyAsset.deepVenueSource !== deepSources[0]
  ) {
    errors.push(
      `${path}.deepVenueSource: expected ${printable(deepSources[0])}, received ${printable(policyAsset.deepVenueSource)}`,
    );
  }
  const deepSource =
    deepSources.length === 1 ? context?.sources.get(deepSources[0]) : undefined;
  if (deepSource && !SUPPORTED_CEX_PROVIDERS.has(deepSource.provider)) {
    errors.push(
      `${path}.deepVenueSource: ${printable(deepSources[0])} must name a source backed by a Phase-2 external CEX adapter`,
    );
  }
  if (!policySourceIds.has(policyAsset.deepVenueSource)) {
    errors.push(
      `${path}.deepVenueSource: ${printable(policyAsset.deepVenueSource)} is not a policy source`,
    );
  }
}

function validatePolicy(policy, contexts, errors) {
  const registryAssetIds = new Set(contexts.keys());
  for (const [versionName, version] of policyVersions(policy, errors)) {
    validatePolicyVersionIdentity(version, `policy.${versionName}`, errors);
    const assetsPath = `policy.${versionName}.assets`;
    if (!isRecord(version.assets)) {
      errors.push(`${assetsPath}: expected an object`);
      continue;
    }
    const policyAssetKeys = keysWithinLimit(version.assets, MAX_ASSETS);
    if (policyAssetKeys.count > MAX_ASSETS) {
      errors.push(
        `${assetsPath}: expected at most ${MAX_ASSETS} assets, found ${policyAssetKeys.count}`,
      );
    }
    const policyAssetIds = new Set(policyAssetKeys.keys);
    if (policyAssetIds.size === 0) {
      errors.push(`${assetsPath}: expected at least one asset`);
    }
    const registryAligned = versionName === "active";
    if (registryAligned) {
      compareKeys(
        registryAssetIds,
        policyAssetIds,
        assetsPath,
        "asset",
        errors,
      );
    }
    const assetIds = registryAligned ? registryAssetIds : policyAssetIds;
    for (const slug of [...assetIds].sort()) {
      const context = registryAligned ? contexts.get(slug) : null;
      const policyAsset = version.assets[slug];
      if (registryAligned && !context) continue;
      if (!isRecord(policyAsset)) {
        errors.push(`${assetsPath}[${printable(slug)}]: expected an object`);
        continue;
      }
      validatePolicyAsset(
        policyAsset,
        context,
        `${assetsPath}[${printable(slug)}]`,
        errors,
        versionName === "previous" &&
          version.version === LEGACY_LISTING_ABSENT_CONSECUTIVE_CHECKS_VERSION,
      );
    }
  }
}

function validationState(authority) {
  return {
    authority,
    errors: [],
    contractEntriesByChain: new Map(),
    feedsByChain: new Map(),
    sortedOraclesChains: new Set(),
    tokenOwners: new Map(),
  };
}

export function validatePegRegistryIntegrity({ registry, policy, authority }) {
  const state = validationState(authority);
  const contexts = validateRegistry(registry, state);
  validateSortedOracles(state);
  validatePolicy(policy, contexts, state.errors);
  return [...new Set(state.errors)].sort();
}

function configRequire() {
  const bases = [
    import.meta.url,
    new URL("../metrics-bridge/package.json", import.meta.url),
  ];
  for (const base of bases) {
    const require = createRequire(base);
    try {
      require.resolve("@mento-protocol/config/package.json");
      return require;
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(
    "unable to resolve installed @mento-protocol/config from the repository root or metrics-bridge; run pnpm install",
  );
}

async function importConfigModule(require, specifier) {
  return import(pathToFileURL(require.resolve(specifier)).href);
}

export async function loadMentoConfigAuthority() {
  const require = configRequire();
  const [chains, tokens, reporters] = await Promise.all([
    importConfigModule(require, "@mento-protocol/config/chains"),
    importConfigModule(require, "@mento-protocol/config/tokens"),
    importConfigModule(require, "@mento-protocol/config/oracle-reporters"),
  ]);
  for (const [name, value] of [
    ["hasChain", chains.hasChain],
    ["contractEntries", tokens.contractEntries],
    ["knownRateFeedsByChain", reporters.knownRateFeedsByChain],
  ]) {
    if (typeof value !== "function") {
      throw new Error(`@mento-protocol/config does not export ${name}`);
    }
  }
  return {
    hasChain: chains.hasChain,
    contractEntries: tokens.contractEntries,
    knownRateFeedsByChain: reporters.knownRateFeedsByChain,
  };
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label}: cannot read ${path}: ${error.message}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label}: invalid JSON in ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

function validateGitRef(ref) {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(ref)
  ) {
    throw new Error(`invalid policy base ref ${printable(ref)}`);
  }
}

function gitObjectExists(specifier) {
  const result = spawnSync("git", ["cat-file", "-e", specifier], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function readPolicyFromGit(baseRef) {
  validateGitRef(baseRef);
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(`cannot resolve policy base ref ${baseRef}`, {
      cause: error,
    });
  }
  const specifier = `${baseRef}:${POLICY_REPO_PATH}`;
  if (!gitObjectExists(specifier)) return null;
  let source;
  try {
    source = execFileSync("git", ["show", specifier], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`cannot read policy from ${specifier}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`base policy: invalid JSON in ${specifier}`, {
      cause: error,
    });
  }
}

function inferredPolicyBaseRef() {
  const explicit = process.env.PEG_POLICY_BASE_REF?.trim();
  if (explicit) return explicit;
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) return `origin/${githubBase}`;
  // Local and hosted callers must prove the base commit exists. The only
  // valid no-baseline case is a resolved base that does not yet contain the
  // policy path (the initial introduction); an unavailable ref is an error.
  return "origin/main";
}

function summary(registry) {
  if (!isRecord(registry)) return { assets: 0, sources: 0, monitors: 0 };
  const registryKeys = Object.keys(registry);
  const assets = registryKeys
    .slice(0, MAX_ASSETS)
    .map((key) => registry[key])
    .filter(isRecord);
  return {
    assets: registryKeys.length,
    sources: assets.reduce(
      (count, asset) =>
        count + (Array.isArray(asset.sources) ? asset.sources.length : 0),
      0,
    ),
    monitors: assets.reduce(
      (count, asset) =>
        count + (Array.isArray(asset.monitors) ? asset.monitors.length : 0),
      0,
    ),
  };
}

export async function checkPegRegistryIntegrity({
  registryPath = DEFAULT_REGISTRY_PATH,
  policyPath = DEFAULT_POLICY_PATH,
  basePolicyPath,
  baseRef,
  authority,
} = {}) {
  if (basePolicyPath !== undefined && baseRef !== undefined) {
    throw new Error("basePolicyPath and baseRef are mutually exclusive");
  }
  const [registry, policy, resolvedAuthority, basePolicyFromPath] =
    await Promise.all([
      readJson(registryPath, "registry"),
      readJson(policyPath, "policy"),
      authority === undefined ? loadMentoConfigAuthority() : authority,
      basePolicyPath === undefined
        ? Promise.resolve(null)
        : readJson(basePolicyPath, "base policy"),
    ]);
  const basePolicy =
    basePolicyPath !== undefined
      ? basePolicyFromPath
      : baseRef === undefined
        ? null
        : readPolicyFromGit(baseRef);
  const errors = validatePegRegistryIntegrity({
    registry,
    policy,
    authority: resolvedAuthority,
  });
  if (basePolicyPath !== undefined || basePolicy !== null) {
    errors.push(...validatePegPolicyLineage(basePolicy, policy));
  } else if (baseRef !== undefined && policy.previous !== null) {
    errors.push(
      "policy.previous: initial policy introduction must not retain an unrelated predecessor",
    );
  }
  return {
    errors: [...new Set(errors)].sort(),
    summary: summary(registry),
  };
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (
      argument !== "--registry" &&
      argument !== "--policy" &&
      argument !== "--base-policy" &&
      argument !== "--base-ref"
    ) {
      throw new Error(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    if (argument === "--base-ref") {
      options.baseRef = value;
    } else {
      const key =
        argument === "--registry"
          ? "registryPath"
          : argument === "--policy"
            ? "policyPath"
            : "basePolicyPath";
      options[key] = resolve(process.cwd(), value);
    }
    index += 1;
  }
  return options;
}

async function main() {
  try {
    const options = cliOptions(process.argv.slice(2));
    if (options.help) {
      console.log(
        "Usage: node scripts/check-peg-registry-integrity.mjs [--registry PATH] [--policy PATH] [--base-policy PATH | --base-ref REF]",
      );
      return;
    }
    if (options.basePolicyPath === undefined && options.baseRef === undefined) {
      options.baseRef = inferredPolicyBaseRef();
    }
    const result = await checkPegRegistryIntegrity(options);
    if (result.errors.length > 0) {
      console.error(
        `Peg registry integrity check failed (${result.errors.length}):\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Peg registry integrity check OK: ${result.summary.assets} asset(s), ${result.summary.sources} source(s), ${result.summary.monitors} monitor(s).`,
    );
  } catch (error) {
    console.error(
      `Peg registry integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
