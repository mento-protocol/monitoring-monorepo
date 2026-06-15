import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateDeviationThresholdDrift } from "./check-deviation-threshold-drift.mjs";

const THRESHOLDS_PATH = "shared-config/src/thresholds.ts";
const ALERTS_MAIN_PATH = "alerts/rules/main.tf";
const FPMM_RULES_PATH = "alerts/rules/rules-fpmms.tf";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const relativeScriptPath = relative(
  repoRoot,
  fileURLToPath(
    new URL("./check-deviation-threshold-drift.mjs", import.meta.url),
  ),
);

function sources({
  tolerance = "1.01",
  critical = "1.05",
  mainTolerance = tolerance,
  mainCritical = critical,
  annotationTolerancePercent = "1",
  annotationCriticalPercent = "5",
  warningAnnotationTolerancePercent = annotationTolerancePercent,
  criticalAnnotationTolerancePercent = annotationTolerancePercent,
  criticalCrossedThresholdPercent = annotationCriticalPercent,
  criticalBranchThresholdPercent = `${annotationCriticalPercent}.0`,
  criticalFallbackThresholdPercent = annotationCriticalPercent,
  evaluatorTolerance = tolerance,
  bannerTolerance = tolerance,
  bannerCritical = critical,
  extraMainSource = "",
} = {}) {
  return {
    [THRESHOLDS_PATH]: `export const DEVIATION_TOLERANCE_RATIO = ${tolerance};
export const DEVIATION_CRITICAL_RATIO = ${critical};
`,
    [ALERTS_MAIN_PATH]: `
deviation_critical_magnitude_promql = "(mento_pool_deviation_open_breach_peak_ratio > ${mainCritical}) or on(chain_id, pool_id, pair) (mento_pool_deviation_ratio > ${mainCritical})"
deviation_critical_gate_promql = format(
  "((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) (mento_pool_deviation_ratio > ${mainTolerance}) and on(chain_id, pool_id, pair) (%s))",
  local.deviation_critical_magnitude_promql,
)
deviation_warning_summary_annotation = <<-EOT
{{- printf "Pool %.0f%% above ${warningAnnotationTolerancePercent}%% tolerance." $values.Dev.Value -}}
Pool above ${warningAnnotationTolerancePercent}% tolerance.
EOT
deviation_critical_summary_annotation = <<-EOT
{{- if lt $dev ${criticalBranchThresholdPercent} -}}
  {{- printf "Pool crossed ${criticalCrossedThresholdPercent}%% threshold and remains %.0f%% above ${criticalAnnotationTolerancePercent}%% tolerance." $dev -}}
{{- else -}}
  Pool above ${criticalFallbackThresholdPercent}% threshold.
{{- end -}}
EOT
${extraMainSource}
`,
    [FPMM_RULES_PATH]: `
# DEVIATION THRESHOLDS -- the bare \`${bannerTolerance}\` (warn) and \`${bannerCritical}\` (critical) literals
conditions = [{
  evaluator = { params = [${evaluatorTolerance}], type = "gt" }
}]
`,
  };
}

test("passes when Terraform literals mirror shared-config thresholds", () => {
  const result = validateDeviationThresholdDrift(sources());

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.thresholds, { tolerance: "1.01", critical: "1.05" });
});

test("fails when shared-config tolerance changes without Terraform updates", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      mainTolerance: "1.01",
      annotationTolerancePercent: "1",
      evaluatorTolerance: "1.01",
      bannerTolerance: "1.01",
    }),
  );

  assert.equal(result.failures.length, 5);
  assert.match(result.failures.join("\n"), /current ratio above tolerance/);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors warning/,
  );
  assert.match(
    result.failures.join("\n"),
    /warning annotation mirrors warning/,
  );
  assert.match(result.failures.join("\n"), /warning Grafana threshold/);
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("fails when shared-config critical changes without Terraform updates", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      critical: "1.06",
      mainCritical: "1.05",
      annotationCriticalPercent: "5",
      bannerCritical: "1.05",
    }),
  );

  assert.equal(result.failures.length, 5);
  assert.match(result.failures.join("\n"), /open-breach peak above critical/);
  assert.match(result.failures.join("\n"), /current ratio above critical/);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors critical/,
  );
  assert.match(result.failures.join("\n"), /crossed branch mirrors critical/);
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("fails when alert annotation percentages do not mirror thresholds", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      annotationTolerancePercent: "0.5",
      annotationCriticalPercent: "4",
    }),
  );

  assert.equal(result.failures.length, 4);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors critical/,
  );
  assert.match(result.failures.join("\n"), /crossed branch mirrors critical/);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors warning/,
  );
  assert.match(
    result.failures.join("\n"),
    /warning annotation mirrors warning/,
  );
});

test("does not accept partial percent literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      mainTolerance: "1.02",
      annotationTolerancePercent: "12",
      evaluatorTolerance: "1.02",
      bannerTolerance: "1.02",
      annotationCriticalPercent: "15",
    }),
  );

  assert.equal(result.failures.length, 4);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors critical/,
  );
  assert.match(result.failures.join("\n"), /crossed branch mirrors critical/);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors warning/,
  );
  assert.match(
    result.failures.join("\n"),
    /warning annotation mirrors warning/,
  );
});

test("fails when only one critical annotation threshold literal is updated", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      critical: "1.06",
      mainCritical: "1.06",
      annotationCriticalPercent: "6",
      criticalBranchThresholdPercent: "6.0",
      criticalFallbackThresholdPercent: "5",
      bannerCritical: "1.06",
    }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures.join("\n"),
    /critical annotation mirrors critical/,
  );
});

test("fails when the warning annotation tolerance text remains stale", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      mainTolerance: "1.02",
      annotationTolerancePercent: "2",
      warningAnnotationTolerancePercent: "1",
      evaluatorTolerance: "1.02",
      bannerTolerance: "1.02",
    }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures.join("\n"),
    /warning annotation mirrors warning/,
  );
});

test("scopes PromQL threshold checks to the intended locals", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      critical: "1.06",
      mainCritical: "1.05",
      annotationCriticalPercent: "6",
      criticalBranchThresholdPercent: "6.0",
      criticalFallbackThresholdPercent: "6",
      bannerCritical: "1.06",
      extraMainSource: `
# Unrelated text must not satisfy stale local assignments.
# mento_pool_deviation_open_breach_peak_ratio > 1.06
# mento_pool_deviation_ratio > 1.06
`,
    }),
  );

  assert.equal(result.failures.length, 2);
  assert.match(result.failures.join("\n"), /open-breach peak above critical/);
  assert.match(result.failures.join("\n"), /current ratio above critical/);
});

test("does not accept partial numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      mainTolerance: "1.010",
      mainCritical: "11.05",
      evaluatorTolerance: "1.010",
      bannerTolerance: "1.010",
      bannerCritical: "1.050",
    }),
  );

  assert.equal(result.failures.length, 5);
});

test("does not accept exponent-suffixed numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      mainTolerance: "1.01e0",
      mainCritical: "1.05e1",
      evaluatorTolerance: "1.01e0",
      bannerTolerance: "1.01e0",
      bannerCritical: "1.05e1",
    }),
  );

  assert.equal(result.failures.length, 5);
});

test("fails when a threshold export is missing", () => {
  assert.throws(
    () =>
      validateDeviationThresholdDrift({
        ...sources(),
        [THRESHOLDS_PATH]: "export const DEVIATION_TOLERANCE_RATIO = 1.01;",
      }),
    /missing numeric export DEVIATION_CRITICAL_RATIO/,
  );
});

test("fails when a Terraform consumer source is missing", () => {
  const incomplete = sources();
  delete incomplete[ALERTS_MAIN_PATH];

  const result = validateDeviationThresholdDrift(incomplete);

  assert.equal(result.failures.length, 7);
  assert.match(
    result.failures.join("\n"),
    /alerts\/rules\/main\.tf: missing source/,
  );
});

test("CLI validates the repository files", () => {
  const output = execFileSync(process.execPath, [relativeScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /Deviation threshold drift check OK/);
});
