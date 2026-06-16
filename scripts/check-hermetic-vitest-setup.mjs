import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const SETUP_FILES = [
  "alerts/infra/oncall-announcer/vitest.hermetic-setup.ts",
  "alerts/infra/onchain-event-handler/vitest.hermetic-setup.ts",
  "governance-watchdog/vitest.hermetic-setup.ts",
  "indexer-envio/vitest.hermetic-setup.ts",
  "integration-probes/vitest.hermetic-setup.ts",
  "metrics-bridge/vitest.hermetic-setup.ts",
  "shared-config/vitest.hermetic-setup.ts",
  "ui-dashboard/vitest.hermetic-setup.ts",
];

const hashFile = (relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return { relativePath, hash: "__missing__" };
  }
  const hash = createHash("sha256")
    .update(readFileSync(absolutePath))
    .digest("hex");
  return { relativePath, hash };
};

const results = SETUP_FILES.map(hashFile);
const uniqueHashes = new Set(results.map((result) => result.hash));

if (uniqueHashes.size !== 1 || uniqueHashes.has("__missing__")) {
  console.error(
    "ERROR: vitest.hermetic-setup.ts files have diverged across workspaces:",
  );
  for (const result of results) {
    console.error(`${result.hash}  ${result.relativePath}`);
  }
  process.exit(1);
}

console.log(
  `OK: ${SETUP_FILES.length} vitest.hermetic-setup.ts files are byte-identical (${results[0].hash})`,
);
