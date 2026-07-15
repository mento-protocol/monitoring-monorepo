"use strict";

/**
 * Format the sticky-comment headline from the workflow step's real outcome.
 * LHCI renders hard assertion failures with a terminal `✘`, not the `❌`
 * emoji, so parsing presentation glyphs can misclassify a failed step.
 *
 * @param {{ stepOutcome?: string, lhciOutput?: string }} input
 * @returns {string}
 */
function formatLighthouseStatus({ stepOutcome, lhciOutput = "" }) {
  switch (stepOutcome) {
    case "success":
      return "✅ passed";
    case "failure":
      return "❌ failed";
    case "cancelled":
      return "⚠️ cancelled";
    case "skipped":
      return "⚠️ did not run";
    default:
      return lhciOutput.trim().length > 0
        ? "⚠️ outcome unavailable"
        : "⚠️ did not run";
  }
}

module.exports = { formatLighthouseStatus };
