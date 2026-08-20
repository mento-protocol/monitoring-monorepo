import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateDeviationThresholdDrift } from "./check-deviation-threshold-drift.mjs";

const THRESHOLDS_PATH = "shared-config/src/thresholds.ts";
const ALERTS_MAIN_PATH = "alerts/rules/main.tf";
const FPMM_RULES_PATH = "alerts/rules/rules-fpmms.tf";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const relativeScriptPath = relative(
  repoRoot,
  fileURLToPath(
    new URL("./check-deviation-threshold-drift.mjs", import.meta.url),
  ),
);

// Each knob names one mirror site. Passing a knob that disagrees with its
// shared-config counterpart is how a test reproduces a real desync.
function sources({
  tolerance = "1.01",
  depletionCritical = "0.2",
  depletionPage = "0.1",
  annotationTolerancePercent = "1",
  evaluatorTolerance = tolerance,
  evaluatorDepletionCritical = depletionCritical,
  evaluatorDepletionPage = depletionPage,
  bandFloor = depletionPage,
  bannerTolerance = tolerance,
  bannerDepletionCritical = depletionCritical,
  bannerDepletionPage = depletionPage,
  extraMainSource = "",
  extraFpmmsSource = "",
} = {}) {
  return {
    [THRESHOLDS_PATH]: `export const DEVIATION_TOLERANCE_RATIO = ${tolerance};
export const DEVIATION_CRITICAL_RATIO = 1.05;
export const POOL_DEPLETION_CRITICAL_SHARE = ${depletionCritical};
export const POOL_DEPLETION_PAGE_SHARE = ${depletionPage};
`,
    [ALERTS_MAIN_PATH]: `
pool_min_reserve_share_promql = "min without(token_symbol) (mento_pool_reserve_share_token0 or mento_pool_reserve_share_token1)"
pool_depletion_critical_active_promql = "(\${local.pool_min_reserve_share_promql}) >= ${bandFloor}"
deviation_warning_summary_annotation = <<-EOT
{{- printf "Pool %.0f%% above ${annotationTolerancePercent}%% tolerance." $values.Dev.Value -}}
Pool above ${annotationTolerancePercent}% tolerance.
EOT
	${extraMainSource}
	`,
    [FPMM_RULES_PATH]: `
	${extraFpmmsSource}
	# ALERT THRESHOLD MIRRORS -- the bare \`${bannerTolerance}\` (deviation tolerance),
	# \`${bannerDepletionCritical}\` (pool depletion critical side share) and
	# \`${bannerDepletionPage}\` (pool depletion page side share) literals in this file
	resource "grafana_rule_group" "fpmms_deviation" {
	  rule {
	    name = "Deviation Breach"
	    data {
	      ref_id = "threshold"
	      model = jsonencode({
	        conditions = [{
	          evaluator = { params = [${evaluatorTolerance}], type = "gt" }
	        }]
	      })
	    }
	  }
	}
	resource "grafana_rule_group" "fpmms_depletion" {
	  rule {
	    name = "Pool Depletion Risk"
	    data {
	      ref_id = "threshold"
	      model = jsonencode({
	        conditions = [{
	          evaluator = { params = [${evaluatorDepletionCritical}], type = "lt" }
	        }]
	      })
	    }
	  }
	  rule {
	    name = "Pool Nearly One-Sided"
	    data {
	      ref_id = "threshold"
	      model = jsonencode({
	        conditions = [{
	          evaluator = { params = [${evaluatorDepletionPage}], type = "lt" }
	        }]
	      })
	    }
	  }
	}
	`,
  };
}

test("passes when Terraform literals mirror shared-config thresholds", () => {
  const result = validateDeviationThresholdDrift(sources());

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.thresholds, {
    tolerance: "1.01",
    depletionCritical: "0.2",
    depletionPage: "0.1",
  });
});

test("fails when shared-config tolerance changes without Terraform updates", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      annotationTolerancePercent: "1",
      evaluatorTolerance: "1.01",
      bannerTolerance: "1.01",
    }),
  );

  assert.equal(result.failures.length, 3);
  assert.match(result.failures.join("\n"), /warning Grafana threshold/);
  assert.match(
    result.failures.join("\n"),
    /warning annotation mirrors warning/,
  );
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("fails when the depletion critical share is not mirrored", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      depletionCritical: "0.25",
      evaluatorDepletionCritical: "0.2",
      bannerDepletionCritical: "0.2",
    }),
  );

  assert.equal(result.failures.length, 2);
  assert.match(result.failures.join("\n"), /depletion critical evaluator/);
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("fails when the depletion page share is not mirrored", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      depletionPage: "0.05",
      evaluatorDepletionPage: "0.1",
      bandFloor: "0.1",
      bannerDepletionPage: "0.1",
    }),
  );

  assert.equal(result.failures.length, 3);
  assert.match(result.failures.join("\n"), /depletion page evaluator/);
  assert.match(result.failures.join("\n"), /depletion critical band floors/);
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("fails when the band floor drifts away from the page share", () => {
  const result = validateDeviationThresholdDrift(
    sources({ bandFloor: "0.15" }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(result.failures.join("\n"), /depletion critical band floors/);
});

test("fails when the warning annotation tolerance text remains stale", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      annotationTolerancePercent: "1",
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

test("does not accept partial percent literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      tolerance: "1.02",
      annotationTolerancePercent: "12",
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

test("does not accept partial numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      evaluatorTolerance: "1.010",
      evaluatorDepletionCritical: "0.20",
      evaluatorDepletionPage: "0.10",
      bandFloor: "0.10",
      bannerTolerance: "1.010",
      bannerDepletionCritical: "0.20",
      bannerDepletionPage: "0.10",
    }),
  );

  assert.equal(result.failures.length, 5);
});

test("does not accept exponent-suffixed numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      evaluatorTolerance: "1.01e0",
      evaluatorDepletionCritical: "0.2e0",
      evaluatorDepletionPage: "0.1e0",
      bandFloor: "0.1e0",
      bannerTolerance: "1.01e0",
      bannerDepletionCritical: "0.2e0",
      bannerDepletionPage: "0.1e0",
    }),
  );

  assert.equal(result.failures.length, 5);
});

test("scopes each evaluator check to its own named rule", () => {
  // The page rule's evaluator is correct; the critical rule's is stale. A
  // check that searched the whole file would find the page's 0.1 and pass.
  const result = validateDeviationThresholdDrift(
    sources({
      depletionCritical: "0.25",
      evaluatorDepletionCritical: "0.1",
      bannerDepletionCritical: "0.25",
    }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(result.failures.join("\n"), /depletion critical evaluator/);
});

test("scopes the band-floor check to its own local", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      bandFloor: "0.15",
      extraMainSource: `
# Unrelated text must not satisfy a stale local assignment.
# min without(token_symbol) (...) >= 0.1
`,
    }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(result.failures.join("\n"), /depletion critical band floors/);
});

test("ignores commented threshold export statements", () => {
  const fixture = sources({
    tolerance: "1.02",
    annotationTolerancePercent: "2",
    evaluatorTolerance: "1.02",
    bannerTolerance: "1.02",
  });
  fixture[THRESHOLDS_PATH] = `// export const DEVIATION_TOLERANCE_RATIO = 1.01;
export const DEVIATION_TOLERANCE_RATIO = 1.02;
export const POOL_DEPLETION_CRITICAL_SHARE = 0.2;
export const POOL_DEPLETION_PAGE_SHARE = 0.1;
`;

  const result = validateDeviationThresholdDrift(fixture);

  assert.deepEqual(result.failures, []);
  assert.equal(result.thresholds.tolerance, "1.02");
});

test("fails when a mirrored threshold export is missing", () => {
  assert.throws(
    () =>
      validateDeviationThresholdDrift({
        ...sources(),
        [THRESHOLDS_PATH]: "export const DEVIATION_TOLERANCE_RATIO = 1.01;",
      }),
    /missing numeric export POOL_DEPLETION_CRITICAL_SHARE/,
  );
});

test("does not require the analytics-only critical ratio", () => {
  const fixture = sources();
  fixture[THRESHOLDS_PATH] = `export const DEVIATION_TOLERANCE_RATIO = 1.01;
export const POOL_DEPLETION_CRITICAL_SHARE = 0.2;
export const POOL_DEPLETION_PAGE_SHARE = 0.1;
`;

  const result = validateDeviationThresholdDrift(fixture);

  assert.deepEqual(result.failures, []);
});

test("fails when a Terraform consumer source is missing", () => {
  const incomplete = sources();
  delete incomplete[ALERTS_MAIN_PATH];

  const result = validateDeviationThresholdDrift(incomplete);

  assert.equal(result.failures.length, 2);
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

  assert.match(output, /Alert threshold drift check OK/);
});
