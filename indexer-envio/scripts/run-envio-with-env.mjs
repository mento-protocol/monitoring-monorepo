#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const envPath = resolve(projectRoot, ".env");

const parseEnvLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
};

const loadEnvFile = () => {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
};

const assertRequiredConfig = (command) => {
  // stop does not require connectivity or indexing configuration
  if (command === "stop") {
    return;
  }

  const startBlock = process.env.ENVIO_START_BLOCK;
  if (!startBlock) {
    throw new Error(
      "Missing ENVIO_START_BLOCK. Set it in indexers/celo/.env before running Envio.",
    );
  }

  if (!/^\d+$/.test(startBlock)) {
    throw new Error(
      `ENVIO_START_BLOCK must be an integer block number, got "${startBlock}".`,
    );
  }

  if (!process.env.ENVIO_RPC_URL) {
    throw new Error(
      "Missing ENVIO_RPC_URL. Set it in indexers/celo/.env before running Envio.",
    );
  }
};

const main = () => {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    throw new Error(
      "Usage: node scripts/run-envio-with-env.mjs <envio-command> [...args]",
    );
  }

  loadEnvFile();
  // Envio codegen can trigger nested pnpm commands that fail in non-TTY contexts.
  // Scope CI override to codegen so dev/start keep normal local behavior.
  if (command === "codegen" && !process.env.CI) {
    process.env.CI = "true";
  }
  assertRequiredConfig(command);

  const result = spawnSync("pnpm", ["exec", "envio", command, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
};

main();
