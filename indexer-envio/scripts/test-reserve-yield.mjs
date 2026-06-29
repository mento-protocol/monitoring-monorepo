#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const defaultConfigPath = "config.yaml";
const mainnetConfigPath = "config.multichain.mainnet.yaml";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const defaultConfig = readFileSync(defaultConfigPath, "utf8");
const mainnetConfig = readFileSync(mainnetConfigPath, "utf8");

const mainnetCodegen = run(
  "node",
  [
    "./scripts/run-envio-with-env.mjs",
    "codegen",
    "--config",
    mainnetConfigPath,
  ],
  { env: { ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD: "0" } },
);

let testStatus = mainnetCodegen;
if (mainnetCodegen === 0) {
  // Envio's test harness reads the default config path. This intentionally
  // follows a config.yaml symlink, then restores the original target content.
  writeFileSync(defaultConfigPath, mainnetConfig, "utf8");
  try {
    testStatus = run(
      "pnpm",
      ["exec", "vitest", "run", "test/susds.test.ts", "test/steth.test.ts"],
      {
        env: {
          ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD: "0",
          RESERVE_YIELD_EVENT_TESTS: "1",
        },
      },
    );
  } finally {
    writeFileSync(defaultConfigPath, defaultConfig, "utf8");
  }
}

const restoreStatus = run(
  "node",
  [
    "./scripts/run-envio-with-env.mjs",
    "codegen",
    "--config",
    mainnetConfigPath,
  ],
  { env: { ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD: "0" } },
);

process.exit(testStatus || restoreStatus);
