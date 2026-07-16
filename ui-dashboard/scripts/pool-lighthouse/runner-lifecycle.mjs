import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultOutputDir, nextDevPath, nextEnvPath } from "./contract.mjs";

export function usage() {
  return `Usage: node ui-dashboard/scripts/run-pool-lighthouse.mjs [options]

Options:
  --output-dir <path>  Artifact root (default: ui-dashboard/reports/lighthouse-pool)
  --skip-build         Reuse a build compiled for $NEXT_PUBLIC_HASURA_URL
  --help               Show this help
`;
}

export function cliOptions() {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    help: values.help,
    outputDir: resolve(values["output-dir"] ?? defaultOutputDir),
    skipBuild: values["skip-build"],
  };
}

export async function prepareOutput(outputDir) {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    rm(join(outputDir, "lhr"), { recursive: true, force: true }),
    rm(join(outputDir, "reports"), { recursive: true, force: true }),
    rm(join(outputDir, "fixture-diagnostics.json"), { force: true }),
    rm(join(outputDir, "fixture-diagnostics.md"), { force: true }),
    rm(join(outputDir, "runner-error.txt"), { force: true }),
  ]);
}

export async function captureNextFiles() {
  const nextEnvExisted = existsSync(nextEnvPath);
  const originalNextEnv = nextEnvExisted
    ? await readFile(nextEnvPath, "utf8")
    : "";
  return { nextEnvExisted, originalNextEnv };
}

export async function restoreNextFiles({ nextEnvExisted, originalNextEnv }) {
  if (nextEnvExisted) await writeFile(nextEnvPath, originalNextEnv);
  else await rm(nextEnvPath, { force: true });
  await rm(nextDevPath, { recursive: true, force: true });
}

export async function writeRunnerError(outputDir, error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  await writeFile(join(outputDir, "runner-error.txt"), `${String(message)}\n`);
}
