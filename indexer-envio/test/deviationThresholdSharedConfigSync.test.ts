import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVIATION_CRITICAL_DEN,
  DEVIATION_CRITICAL_NUM,
  DEVIATION_TOLERANCE_DEN,
  DEVIATION_TOLERANCE_NUM,
} from "../src/pool/health.js";

/**
 * Drift-protection test. `indexer-envio/src/pool/health.ts` stores the
 * deviation-threshold boundaries as `num/den` bigint pairs for integer-safe
 * arithmetic. `shared-config/src/thresholds.ts` stores the same boundaries
 * as IEEE-754 float ratios (consumed by the dashboard and metrics-bridge).
 *
 * We can't import shared-config at runtime (Envio builds outside the pnpm
 * workspace — see src/contractAddresses.ts:14-18), so instead we fs-read
 * the source file and regex-extract the float literals, then assert that the
 * bigint fraction equals the float.
 *
 * Both 101/100 === 1.01 and 105/100 === 1.05 are exact in IEEE-754 (no
 * rounding error), so strict equality is safe here.
 *
 * If this test fails, update BOTH files together:
 *   - indexer-envio/src/pool/health.ts   (bigint NUM/DEN pairs)
 *   - shared-config/src/thresholds.ts    (float RATIO constants)
 */
describe("deviation thresholds — numeric parity with shared-config/src/thresholds.ts", () => {
  const sharedConfigPath = join(
    import.meta.dirname,
    "..",
    "..",
    "shared-config",
    "src",
    "thresholds.ts",
  );
  const source = readFileSync(sharedConfigPath, "utf8");

  function extractRatio(name: string): number {
    const match = source.match(
      new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)`),
    );
    assert.ok(
      match,
      `Could not find 'export const ${name}' in shared-config/src/thresholds.ts`,
    );
    return Number(match[1]);
  }

  it("DEVIATION_TOLERANCE_NUM/DEN equals DEVIATION_TOLERANCE_RATIO", () => {
    const ratio = extractRatio("DEVIATION_TOLERANCE_RATIO");
    assert.strictEqual(
      Number(DEVIATION_TOLERANCE_NUM) / Number(DEVIATION_TOLERANCE_DEN),
      ratio,
      "DEVIATION_TOLERANCE_NUM/DEN in indexer-envio/src/pool/health.ts does not equal " +
        `DEVIATION_TOLERANCE_RATIO (${ratio}) in shared-config/src/thresholds.ts. ` +
        "Update both files together.",
    );
  });

  it("DEVIATION_CRITICAL_NUM/DEN equals DEVIATION_CRITICAL_RATIO", () => {
    const ratio = extractRatio("DEVIATION_CRITICAL_RATIO");
    assert.strictEqual(
      Number(DEVIATION_CRITICAL_NUM) / Number(DEVIATION_CRITICAL_DEN),
      ratio,
      "DEVIATION_CRITICAL_NUM/DEN in indexer-envio/src/pool/health.ts does not equal " +
        `DEVIATION_CRITICAL_RATIO (${ratio}) in shared-config/src/thresholds.ts. ` +
        "Update both files together.",
    );
  });
});
