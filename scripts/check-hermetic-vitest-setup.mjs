import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const WORKSPACES = [
  "alerts/infra/oncall-announcer",
  "alerts/infra/onchain-event-handler",
  "governance-watchdog",
  "indexer-envio",
  "integration-probes",
  "metrics-bridge",
  "shared-config",
  "ui-dashboard",
];

const SETUP_FILES = WORKSPACES.map(
  (workspace) => `${workspace}/vitest.hermetic-setup.ts`,
);

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

const guardConfigReference = "./vitest.hermetic-setup.ts";

const configLoadsGuard = (workspace) => {
  const relativePath = `${workspace}/vitest.config.ts`;
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return { relativePath, ok: false, reason: "missing config" };
  }
  const contents = readFileSync(absolutePath, "utf8");
  if (
    !contents.includes(`"${guardConfigReference}"`) &&
    !contents.includes(`'${guardConfigReference}'`)
  ) {
    return { relativePath, ok: false, reason: "missing setupFiles guard" };
  }
  return { relativePath, ok: true };
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

const configResults = WORKSPACES.map(configLoadsGuard);
const missingConfigReferences = configResults.filter((result) => !result.ok);

if (missingConfigReferences.length > 0) {
  console.error(
    "ERROR: vitest configs must load ./vitest.hermetic-setup.ts via setupFiles:",
  );
  for (const result of missingConfigReferences) {
    console.error(`${result.reason}: ${result.relativePath}`);
  }
  process.exit(1);
}

console.log(
  `OK: ${SETUP_FILES.length} vitest.hermetic-setup.ts files are byte-identical (${results[0].hash}) and wired from vitest.config.ts`,
);
