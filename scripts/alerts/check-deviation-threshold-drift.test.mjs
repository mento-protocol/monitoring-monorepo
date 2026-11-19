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
  alertLine = "1.05",
  depletionCritical = "0.2",
  depletionPage = "0.1",
  annotationAlertPercent = "5",
  resolvedAlertLine = alertLine,
  anchoredAlertLine = alertLine,
  evaluatorAlertLine = alertLine,
  evaluatorDepletionCritical = depletionCritical,
  evaluatorDepletionPage = depletionPage,
  bandFloor = depletionPage,
  bannerAlertLine = alertLine,
  bannerDepletionCritical = depletionCritical,
  bannerDepletionPage = depletionPage,
  extraMainSource = "",
  extraFpmmsSource = "",
} = {}) {
  return {
    [THRESHOLDS_PATH]: `export const DEVIATION_TOLERANCE_RATIO = ${tolerance};
export const DEVIATION_CRITICAL_RATIO = ${alertLine};
export const POOL_DEPLETION_CRITICAL_SHARE = ${depletionCritical};
export const POOL_DEPLETION_PAGE_SHARE = ${depletionPage};
`,
    [ALERTS_MAIN_PATH]: `
pool_min_reserve_value_share_promql = "min without(token_symbol) (mento_pool_reserve_value_share_token0 or mento_pool_reserve_value_share_token1)"
pool_depletion_critical_active_promql = "(\${local.pool_min_reserve_value_share_promql}) >= ${bandFloor}"
deviation_warning_unavailable_active_promql = "((time() - mento_pool_deviation_breach_start) and on(chain_id, pool_id, pair) ((mento_pool_deviation_open_breach_peak_ratio > ${anchoredAlertLine}) or on(chain_id, pool_id, pair) (max_over_time(mento_pool_deviation_ratio[1d]) > ${anchoredAlertLine})))"
deviation_warning_resolved_summary_annotation = <<-EOT
{{- if and (not $reason) $values.A (le $values.A.Value ${resolvedAlertLine}) -}}
Pool is back under the ${annotationAlertPercent}% alert line.
{{- end -}}
EOT
	${extraMainSource}
	`,
    [FPMM_RULES_PATH]: `
	${extraFpmmsSource}
	# ALERT THRESHOLD MIRRORS -- the bare \`${bannerAlertLine}\` (deviation alert line),
	# \`${bannerDepletionCritical}\` (pool depletion critical side share) and
	# \`${bannerDepletionPage}\` (pool depletion page side share) literals in this file
	resource "grafana_rule_group" "fpmms_deviation" {
	  rule {
	    name = "Deviation Breach"
	    data {
	      ref_id = "threshold"
	      model = jsonencode({
	        conditions = [{
	          evaluator = { params = [${evaluatorAlertLine}], type = "gt" }
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
    alertLine: "1.05",
    depletionCritical: "0.2",
    depletionPage: "0.1",
  });
});

test("fails when the shared-config alert line changes without Terraform updates", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      alertLine: "1.06",
      annotationAlertPercent: "5",
      resolvedAlertLine: "1.05",
      anchoredAlertLine: "1.05",
      evaluatorAlertLine: "1.05",
      bannerAlertLine: "1.05",
    }),
  );

  assert.equal(result.failures.length, 6);
  assert.match(result.failures.join("\n"), /warning Grafana threshold/);
  assert.match(result.failures.join("\n"), /anchored fallback/);
  assert.match(result.failures.join("\n"), /alert line ratio/);
  assert.match(result.failures.join("\n"), /alert line percent/);
  assert.match(result.failures.join("\n"), /threshold banner/);
});

test("ignores the tolerance ratio, which no Grafana evaluator reads", () => {
  const result = validateDeviationThresholdDrift(
    sources({ tolerance: "1.02" }),
  );

  assert.deepEqual(result.failures, []);
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

test("fails when the resolved annotation alert-line text remains stale", () => {
  const result = validateDeviationThresholdDrift(
    sources({ alertLine: "1.06", annotationAlertPercent: "5" }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(result.failures.join("\n"), /alert line percent/);
});

test("does not accept partial percent literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({ alertLine: "1.06", annotationAlertPercent: "16" }),
  );

  assert.equal(result.failures.length, 1);
  assert.match(result.failures.join("\n"), /alert line percent/);
});

test("does not accept partial numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      evaluatorAlertLine: "1.050",
      resolvedAlertLine: "1.050",
      anchoredAlertLine: "1.050",
      evaluatorDepletionCritical: "0.20",
      evaluatorDepletionPage: "0.10",
      bandFloor: "0.10",
      bannerAlertLine: "1.050",
      bannerDepletionCritical: "0.20",
      bannerDepletionPage: "0.10",
    }),
  );

  assert.equal(result.failures.length, 8);
});

test("does not accept exponent-suffixed numeric literal matches", () => {
  const result = validateDeviationThresholdDrift(
    sources({
      evaluatorAlertLine: "1.05e0",
      resolvedAlertLine: "1.05e0",
      anchoredAlertLine: "1.05e0",
      evaluatorDepletionCritical: "0.2e0",
      evaluatorDepletionPage: "0.1e0",
      bandFloor: "0.1e0",
      bannerAlertLine: "1.05e0",
      bannerDepletionCritical: "0.2e0",
      bannerDepletionPage: "0.1e0",
    }),
  );

  assert.equal(result.failures.length, 8);
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
  const fixture = sources({ alertLine: "1.06", annotationAlertPercent: "6" });
  fixture[THRESHOLDS_PATH] = `// export const DEVIATION_CRITICAL_RATIO = 1.05;
export const DEVIATION_CRITICAL_RATIO = 1.06;
export const POOL_DEPLETION_CRITICAL_SHARE = 0.2;
export const POOL_DEPLETION_PAGE_SHARE = 0.1;
`;

  const result = validateDeviationThresholdDrift(fixture);

  assert.deepEqual(result.failures, []);
  assert.equal(result.thresholds.alertLine, "1.06");
});

test("fails when a mirrored threshold export is missing", () => {
  assert.throws(
    () =>
      validateDeviationThresholdDrift({
        ...sources(),
        [THRESHOLDS_PATH]: "export const DEVIATION_CRITICAL_RATIO = 1.05;",
      }),
    /missing numeric export POOL_DEPLETION_CRITICAL_SHARE/,
  );
});

test("does not require the tolerance ratio", () => {
  const fixture = sources();
  fixture[THRESHOLDS_PATH] = `export const DEVIATION_CRITICAL_RATIO = 1.05;
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

  assert.equal(result.failures.length, 5);
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
