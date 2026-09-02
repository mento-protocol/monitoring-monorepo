// One classifier owns handler-invariant routing for the quality gate data
// model. Callers receive a detached, deeply frozen view so they can derive
// their own representation without changing later decisions.
import { INDEXER_HANDLER_INVARIANT_FAMILIES } from "./indexer-handler-invariant-families.mjs";

const VALIDATED_INDEXER_HANDLER_INVARIANT_FAMILIES =
  validateAndFreezeIndexerHandlerInvariantFamilies(
    INDEXER_HANDLER_INVARIANT_FAMILIES,
  );

function indexerRoutingFamilyError(message) {
  throw new Error(
    `invalid indexer handler invariant routing families: ${message}`,
  );
}

function assertIndexerRoutingStringList(value, where) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    indexerRoutingFamilyError(`${where} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) {
    indexerRoutingFamilyError(`${where} contains a duplicate`);
  }
}

function isCanonicalIndexerRoutingPath(value) {
  return (
    /^[A-Za-z0-9._/@+-]+$/.test(value) &&
    value.startsWith("indexer-envio/") &&
    !value.startsWith("/") &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isCanonicalIndexerRoutingFilePath(value) {
  return isCanonicalIndexerRoutingPath(value) && !value.endsWith("/");
}

function validateIndexerHandlerInvariantRoutingFamilies(families) {
  if (!Array.isArray(families) || families.length === 0) {
    indexerRoutingFamilyError("the family list must be non-empty");
  }

  const owners = new Set();
  const explicitFamilies = [];
  const fallbackFamilies = [];
  for (const [index, family] of families.entries()) {
    const where = `family ${index}`;
    if (
      family === null ||
      typeof family !== "object" ||
      Array.isArray(family)
    ) {
      indexerRoutingFamilyError(`${where} must be an object`);
    }
    const allowedKeys = new Set(["owner", "route", "exact", "fallback"]);
    const unknownKeys = Object.keys(family).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      indexerRoutingFamilyError(
        `${where} has unknown keys: ${unknownKeys.join(", ")}`,
      );
    }
    if (typeof family.owner !== "string" || family.owner.trim() === "") {
      indexerRoutingFamilyError(`${where}.owner must be a non-empty string`);
    }
    if (owners.has(family.owner)) {
      indexerRoutingFamilyError(`owner ${family.owner} is duplicated`);
    }
    owners.add(family.owner);
    if (typeof family.route !== "boolean") {
      indexerRoutingFamilyError(`${where}.route must be boolean`);
    }

    const strategies = ["exact", "fallback"].filter(
      (key) => family[key] !== undefined,
    );
    if (strategies.length !== 1) {
      indexerRoutingFamilyError(
        `${where} must define exactly one of exact or fallback`,
      );
    }

    if (family.exact !== undefined) {
      assertIndexerRoutingStringList(family.exact, `${where}.exact`);
      if (
        family.exact.some((entry) => !isCanonicalIndexerRoutingFilePath(entry))
      ) {
        indexerRoutingFamilyError(
          `${where}.exact contains a noncanonical or Bash-unsafe literal path`,
        );
      }
      explicitFamilies.push(family);
      continue;
    }

    const fallback = family.fallback;
    if (
      fallback === null ||
      typeof fallback !== "object" ||
      Array.isArray(fallback) ||
      Object.keys(fallback).sort().join(",") !== "extensions,prefixes"
    ) {
      indexerRoutingFamilyError(
        `${where}.fallback must define only prefixes and extensions`,
      );
    }
    assertIndexerRoutingStringList(
      fallback.prefixes,
      `${where}.fallback.prefixes`,
    );
    assertIndexerRoutingStringList(
      fallback.extensions,
      `${where}.fallback.extensions`,
    );
    const requiredPrefixes = ["indexer-envio/src/", "indexer-envio/test/"];
    const requiredExtensions = [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "json",
    ];
    if (
      fallback.prefixes.some(
        (prefix) =>
          !prefix.endsWith("/") || !isCanonicalIndexerRoutingPath(prefix),
      ) ||
      fallback.extensions.some((extension) => !/^[a-z0-9]+$/.test(extension)) ||
      fallback.prefixes.length !== requiredPrefixes.length ||
      requiredPrefixes.some((prefix) => !fallback.prefixes.includes(prefix)) ||
      fallback.extensions.length !== requiredExtensions.length ||
      requiredExtensions.some(
        (extension) => !fallback.extensions.includes(extension),
      )
    ) {
      indexerRoutingFamilyError(
        `${where}.fallback must define only the canonical src/test JS, JSON, or TS module scope`,
      );
    }
    if (family.route) {
      indexerRoutingFamilyError(`${where}.fallback must remain unclassified`);
    }
    fallbackFamilies.push(family);
  }

  if (fallbackFamilies.length !== 1) {
    indexerRoutingFamilyError("exactly one future fallback family is required");
  }

  const exactPaths = explicitFamilies.flatMap(({ exact = [] }) => exact);
  for (const candidatePath of exactPaths) {
    const matches = explicitFamilies.filter((family) =>
      matchesIndexerHandlerInvariantFamily(family, candidatePath),
    );
    if (matches.length !== 1) {
      indexerRoutingFamilyError(
        `explicit path ${candidatePath} has ${matches.length} owners: ${matches
          .map(({ owner }) => owner)
          .join(", ")}`,
      );
    }
  }

  return families;
}

function validateAndFreezeIndexerHandlerInvariantFamilies(families) {
  validateIndexerHandlerInvariantRoutingFamilies(families);
  return deepFreezeIndexerRoutingValue(families);
}

function deepFreezeIndexerRoutingValue(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreezeIndexerRoutingValue(nested);
    }
  }
  return value;
}

function copyIndexerHandlerInvariantFamily(family) {
  return {
    owner: family.owner,
    route: family.route,
    ...(family.exact === undefined ? {} : { exact: [...family.exact] }),
    ...(family.fallback === undefined
      ? {}
      : {
          fallback: {
            prefixes: [...family.fallback.prefixes],
            extensions: [...family.fallback.extensions],
          },
        }),
  };
}

export function getIndexerHandlerInvariantRoutingFamilies() {
  return deepFreezeIndexerRoutingValue(
    VALIDATED_INDEXER_HANDLER_INVARIANT_FAMILIES.map(
      copyIndexerHandlerInvariantFamily,
    ),
  );
}

function matchesIndexerHandlerInvariantFamily(family, candidatePath) {
  return family.exact?.includes(candidatePath) ?? false;
}

function matchesIndexerHandlerInvariantFallback(family, candidatePath) {
  return (
    family.fallback !== undefined &&
    family.fallback.prefixes.some((prefix) =>
      candidatePath.startsWith(prefix),
    ) &&
    family.fallback.extensions.some((extension) =>
      candidatePath.endsWith(`.${extension}`),
    )
  );
}

function getIndexerHandlerInvariantDecision(candidatePath, families) {
  const matches = families.filter(
    (family) =>
      family.fallback === undefined &&
      matchesIndexerHandlerInvariantFamily(family, candidatePath),
  );
  if (matches.length > 1) {
    throw new Error(
      `indexer handler invariant families overlap for ${candidatePath}: ${matches
        .map(({ owner }) => owner)
        .join(", ")}`,
    );
  }
  if (matches.length === 1) {
    return {
      path: candidatePath,
      route: matches[0].route,
      owner: matches[0].owner,
    };
  }

  const fallbacks = families.filter((family) =>
    matchesIndexerHandlerInvariantFallback(family, candidatePath),
  );
  if (fallbacks.length > 1) {
    throw new Error(
      `indexer handler invariant fallbacks overlap for ${candidatePath}: ${fallbacks
        .map(({ owner }) => owner)
        .join(", ")}`,
    );
  }
  if (fallbacks.length === 1) {
    return {
      path: candidatePath,
      route: fallbacks[0].route,
      owner: fallbacks[0].owner,
    };
  }
  return {
    path: candidatePath,
    route: false,
    owner: "outside-indexer-handler-invariant-scope",
  };
}

export function getIndexerHandlerInvariantChecklistDecisions(paths) {
  if (
    !Array.isArray(paths) ||
    paths.some((candidatePath) => typeof candidatePath !== "string")
  ) {
    throw new TypeError(
      "indexer handler invariant paths must be an array of strings",
    );
  }
  const families = getIndexerHandlerInvariantRoutingFamilies();
  return paths.map((candidatePath) =>
    getIndexerHandlerInvariantDecision(candidatePath, families),
  );
}
