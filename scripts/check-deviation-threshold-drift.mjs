#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THRESHOLDS_PATH = "shared-config/src/thresholds.ts";
const ALERTS_MAIN_PATH = "alerts/rules/main.tf";
const FPMM_RULES_PATH = "alerts/rules/rules-fpmms.tf";

const THRESHOLD_EXPORTS = {
  tolerance: "DEVIATION_TOLERANCE_RATIO",
  critical: "DEVIATION_CRITICAL_RATIO",
};

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberLiteral(value) {
  return `(?<![0-9A-Za-z_.+-])${escapeRegex(value)}(?![0-9A-Za-z_.+-])`;
}

function ratioToPercentLiteral(value) {
  const [whole, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  let percentNumerator = (numerator - denominator) * 100n;
  const sign = percentNumerator < 0n ? "-" : "";
  if (percentNumerator < 0n) percentNumerator = -percentNumerator;

  const integer = percentNumerator / denominator;
  let remainder = percentNumerator % denominator;
  if (remainder === 0n) return `${sign}${integer}`;

  let decimals = "";
  while (remainder !== 0n && decimals.length < 12) {
    remainder *= 10n;
    decimals += remainder / denominator;
    remainder %= denominator;
  }
  return `${sign}${integer}.${decimals.replace(/0+$/, "")}`;
}

function extractThreshold(source, exportName) {
  const match = source.match(
    new RegExp(
      `export\\s+const\\s+${exportName}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`,
    ),
  );
  if (!match) {
    throw new Error(`missing numeric export ${exportName}`);
  }
  return match[1];
}

function requiredChecks(thresholds) {
  const tolerance = numberLiteral(thresholds.tolerance);
  const critical = numberLiteral(thresholds.critical);
  const tolerancePercent = escapeRegex(
    ratioToPercentLiteral(thresholds.tolerance),
  );
  const criticalPercent = escapeRegex(
    ratioToPercentLiteral(thresholds.critical),
  );

  return [
    {
      file: ALERTS_MAIN_PATH,
      description: "critical gate still requires current ratio above tolerance",
      pattern: new RegExp(`mento_pool_deviation_ratio\\s*>\\s*${tolerance}`),
    },
    {
      file: ALERTS_MAIN_PATH,
      description:
        "critical gate still requires open-breach peak above critical",
      pattern: new RegExp(
        `mento_pool_deviation_open_breach_peak_ratio\\s*>\\s*${critical}`,
      ),
    },
    {
      file: ALERTS_MAIN_PATH,
      description: "critical gate still requires current ratio above critical",
      pattern: new RegExp(`mento_pool_deviation_ratio\\s*>\\s*${critical}`),
    },
    {
      file: ALERTS_MAIN_PATH,
      description: "critical annotation mirrors critical threshold percent",
      pattern: new RegExp(
        `deviation_critical_summary_annotation\\s*=\\s*<<-EOT[\\s\\S]*?${criticalPercent}%{1,2}\\s+threshold[\\s\\S]*?EOT`,
      ),
    },
    {
      file: ALERTS_MAIN_PATH,
      description: "critical annotation mirrors warning tolerance percent",
      pattern: new RegExp(
        `deviation_critical_summary_annotation\\s*=\\s*<<-EOT[\\s\\S]*?${tolerancePercent}%{1,2}\\s+tolerance[\\s\\S]*?EOT`,
      ),
    },
    {
      file: FPMM_RULES_PATH,
      description: "warning Grafana threshold evaluator mirrors tolerance",
      pattern: new RegExp(
        `evaluator\\s*=\\s*\\{\\s*params\\s*=\\s*\\[${tolerance}\\]\\s*,\\s*type\\s*=\\s*"gt"`,
      ),
    },
    {
      file: FPMM_RULES_PATH,
      description: "threshold banner mirrors tolerance and critical literals",
      pattern: new RegExp(
        `bare\\s+\`${tolerance}\`\\s+\\(warn\\)\\s+and\\s+\`${critical}\`\\s+\\(critical\\)`,
      ),
    },
  ];
}

export function validateDeviationThresholdDrift(sources) {
  const thresholdsSource = sources[THRESHOLDS_PATH];
  if (thresholdsSource === undefined) {
    throw new Error(`missing source: ${THRESHOLDS_PATH}`);
  }

  const thresholds = {
    tolerance: extractThreshold(thresholdsSource, THRESHOLD_EXPORTS.tolerance),
    critical: extractThreshold(thresholdsSource, THRESHOLD_EXPORTS.critical),
  };

  const failures = [];
  for (const check of requiredChecks(thresholds)) {
    const source = sources[check.file];
    if (source === undefined) {
      failures.push(`${check.file}: missing source`);
      continue;
    }
    if (!check.pattern.test(source)) {
      failures.push(
        `${check.file}: expected ${check.description} (${check.pattern.source})`,
      );
    }
  }

  return { failures, thresholds };
}

function readRepoSources(root) {
  return Object.fromEntries(
    [THRESHOLDS_PATH, ALERTS_MAIN_PATH, FPMM_RULES_PATH].map((path) => [
      path,
      readFileSync(resolve(root, path), "utf8"),
    ]),
  );
}

function main() {
  const { failures, thresholds } = validateDeviationThresholdDrift(
    readRepoSources(repoRoot()),
  );
  if (failures.length > 0) {
    console.error(
      "Deviation threshold drift check failed. Mirror shared-config/src/thresholds.ts into alerts/rules/main.tf and alerts/rules/rules-fpmms.tf.",
    );
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Deviation threshold drift check OK: tolerance=${thresholds.tolerance}, critical=${thresholds.critical}`,
  );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main();
}
