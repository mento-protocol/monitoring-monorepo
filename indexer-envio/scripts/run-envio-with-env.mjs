#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

  if (command === "codegen") {
    const generatedDir = resolve(projectRoot, "generated");
    // Envio codegen generates `generated/` but doesn't install its deps, and
    // critically it returns exit 0 even when rescript compilation fails due to
    // missing deps. We detect failure via the compiled output file, install
    // deps (with rescript allowed to run its postinstall), then retry.
    if (existsSync(generatedDir)) {
      const compiledIndexPath = resolve(generatedDir, "src", "Index.res.js");
      const compilationFailed = !existsSync(compiledIndexPath);

      if (compilationFailed) {
        // Allow rescript's postinstall to run by adding it to onlyBuiltDependencies
        const pkgJsonPath = resolve(generatedDir, "package.json");
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        const alreadyAllowed =
          pkgJson.pnpm?.onlyBuiltDependencies?.includes("rescript");
        if (!alreadyAllowed) {
          pkgJson.pnpm = {
            ...pkgJson.pnpm,
            onlyBuiltDependencies: ["rescript"],
          };
          writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
        }

        const installResult = spawnSync(
          "pnpm",
          ["install", "--ignore-workspace"],
          { stdio: "inherit", cwd: generatedDir, env: process.env },
        );
        if (installResult.error) throw installResult.error;
        if (installResult.status !== 0) process.exit(installResult.status ?? 1);

        const retryResult = spawnSync(
          "pnpm",
          ["exec", "envio", command, ...args],
          { stdio: "inherit", env: process.env },
        );
        if (retryResult.error) throw retryResult.error;
        process.exit(retryResult.status ?? 1);
      }
    }
  }

  process.exit(result.status ?? 1);
};

main();
