import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { formatLighthouseStatus } = require("./lighthouse-comment-status.cjs");

describe("formatLighthouseStatus", () => {
  it("reports a failed LHCI step even when output glyphs look like warnings", () => {
    const lhciOutput = `
Healthcheck passed!
  ✅  categories:performance passing
  ✅  categories:accessibility passing
  ✅  cumulative-layout-shift passing
  ⚠️  upload temporary-public-storage warning
  ✘ largest-contentful-paint failure
Assertion failed. Exiting with status code 1.
`;

    expect(formatLighthouseStatus({ stepOutcome: "failure", lhciOutput })).toBe(
      "❌ failed",
    );
  });

  it.each([
    ["success", "✅ passed"],
    ["cancelled", "⚠️ cancelled"],
    ["skipped", "⚠️ did not run"],
  ])("maps the %s step outcome to %s", (stepOutcome, expected) => {
    expect(formatLighthouseStatus({ stepOutcome, lhciOutput: "ignored" })).toBe(
      expected,
    );
  });

  it("does not claim success when the step outcome is unavailable", () => {
    expect(
      formatLighthouseStatus({
        stepOutcome: "",
        lhciOutput: "Lighthouse produced partial output",
      }),
    ).toBe("⚠️ outcome unavailable");
  });
});
