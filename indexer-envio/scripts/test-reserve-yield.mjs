#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const defaultConfigPath = "config.yaml";
const reserveConfigPath = "config.reserve-yield.mainnet.yaml";
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
const reserveConfig = readFileSync(reserveConfigPath, "utf8");

const reserveCodegen = run(
  "node",
  [
    "./scripts/run-envio-with-env.mjs",
    "codegen",
    "--config",
    reserveConfigPath,
  ],
  { env: { ENVIO_START_BLOCK_ETHEREUM_RESERVE_YIELD: "0" } },
);

let testStatus = reserveCodegen;
if (reserveCodegen === 0) {
  writeFileSync(defaultConfigPath, reserveConfig, "utf8");
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

const restoreStatus = run("node", [
  "./scripts/run-envio-with-env.mjs",
  "codegen",
  "--config",
  mainnetConfigPath,
]);

process.exit(testStatus || restoreStatus);
