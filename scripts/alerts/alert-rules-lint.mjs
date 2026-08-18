#!/usr/bin/env node
/**
 * Static checks for the Grafana alert-rule stack in alerts/rules/.
 *
 * 1. PromQL syntax lint: every expression the extractor finds in the .tf files
 *    parses under the Prometheus lezer grammar in strict mode.
 * 2. Metric cross-check: every mento_pool_* / mento_cdp_* / mento_peg_* series
 *    name referenced in alerts/rules must be registered in metrics-bridge.
 * 3. Peg policy cross-check: the gated threshold bundle is structurally strict,
 *    matches the service registry exactly, and keeps every peg PromQL selector
 *    bound to the accepted policy version set.
 *
 * This file owns the gauge cross-check and the run. Extraction, parsing, and
 * the ALERT_RULES_LINT_MIN_* floors live in alert-rules-lint-extract.mjs; the
 * peg policy rules live in alert-rules-lint-peg-policy.mjs. Both are re-exported
 * here so callers and the suite have one import surface.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pegPolicyVersionDigest } from "../lib/peg-policy-digest.mjs";
import {
  extractExpressions,
  extractionFloorFailures,
  lintPromql,
  neutralize,
  referencedMetricNames,
  registeredMetricNames,
  stripComments,
  unescapeHcl,
} from "./alert-rules-lint-extract.mjs";
import {
  pegPolicyVersions,
  validatePegPolicyBundle,
  validatePegPromqlExpressions,
} from "./alert-rules-lint-peg-policy.mjs";

export {
  extractExpressions,
  lintPromql,
  neutralize,
  pegPolicyVersionDigest,
  referencedMetricNames,
  registeredMetricNames,
  stripComments,
  unescapeHcl,
  validatePegPolicyBundle,
  validatePegPromqlExpressions,
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rulesDir =
  process.env.ALERT_RULES_LINT_RULES_DIR ?? path.join(repoRoot, "alerts/rules");
const metricsSrcDir =
  process.env.ALERT_RULES_LINT_METRICS_DIR ??
  path.join(repoRoot, "metrics-bridge/src");
const pegPolicyPath =
  process.env.ALERT_RULES_LINT_PEG_POLICY ??
  path.join(rulesDir, "peg-thresholds.json");
const pegRegistryPath =
  process.env.ALERT_RULES_LINT_PEG_REGISTRY ??
  path.join(repoRoot, "metrics-bridge/peg-registry.json");
const GAUGE_SOURCE_FILES = [
  "metrics.ts",
  "cdp-metrics.ts",
  "peg/metrics.ts",
  "peg/listing-metrics.ts",
];

function readJson(file, label, failures) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function main() {
  const failures = [];
  const referenced = new Set();
  let expressions = [];

  const pegPolicy = readJson(pegPolicyPath, "peg policy", failures);
  const pegRegistry = readJson(pegRegistryPath, "peg registry", failures);
  if (pegPolicy !== null && pegRegistry !== null) {
    failures.push(...validatePegPolicyBundle(pegPolicy, pegRegistry));
  }
  const tfFiles = readdirSync(rulesDir)
    .filter((file) => file.endsWith(".tf"))
    .sort();

  for (const file of tfFiles) {
    const cleaned = stripComments(
      readFileSync(path.join(rulesDir, file), "utf8"),
    );
    expressions.push(...extractExpressions(file, cleaned));
    for (const name of referencedMetricNames(cleaned)) referenced.add(name);
  }

  for (const { file, kind, expr } of expressions) {
    const neutralized = neutralize(expr);
    const errorMessage = lintPromql(neutralized);
    if (errorMessage !== null) {
      failures.push(
        `${file} [${kind}]: ${errorMessage}\n      ${neutralized.trim()}`,
      );
    }
  }
  failures.push(
    ...validatePegPromqlExpressions(expressions, pegPolicyVersions(pegPolicy)),
  );

  const registered = new Set();
  for (const file of GAUGE_SOURCE_FILES) {
    const source = readFileSync(path.join(metricsSrcDir, file), "utf8");
    for (const name of registeredMetricNames(source)) registered.add(name);
  }

  for (const name of [...referenced].sort()) {
    if (!registered.has(name)) {
      failures.push(
        `unknown metric in alerts/rules: ${name} is not registered in metrics-bridge (${GAUGE_SOURCE_FILES.join(", ")})`,
      );
    }
  }

  failures.push(
    ...extractionFloorFailures({
      expressions: expressions.length,
      registered: registered.size,
      referenced: referenced.size,
    }),
  );

  console.log(
    `alert-rules-lint: ${expressions.length} PromQL expressions parsed, ` +
      `${referenced.size} referenced metric names checked against ${registered.size} registered gauges, peg policy validated`,
  );

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} failure(s):\n${failures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
