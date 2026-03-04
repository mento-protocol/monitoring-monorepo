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

  // ENVIO_START_BLOCK and ENVIO_RPC_URL are optional here: the config YAML
  // declares defaults via ${VAR:-default} which the envio CLI resolves at
  // parse time. Throwing when they are absent prevents hosted deployments
  // (where env-var injection is a paid feature) from starting at all.
  const startBlock = process.env.ENVIO_START_BLOCK;
  if (startBlock && !/^\d+$/.test(startBlock)) {
    throw new Error(
      `ENVIO_START_BLOCK must be an integer block number, got "${startBlock}".`,
    );
  }
};

/**
 * Envio's generated docker-compose.yaml doesn't include a healthcheck for the
 * postgres service. Without one, Docker reports Health:"" (empty string) and
 * the envio dev loop waits forever for all services to become healthy.
 *
 * This function patches the generated file to add a postgres healthcheck after
 * every codegen run that regenerates it.
 */
const patchDockerComposeHealthcheck = () => {
  const composePath = resolve(projectRoot, "generated", "docker-compose.yaml");
  if (!existsSync(composePath)) {
    return;
  }

  const content = readFileSync(composePath, "utf8");

  if (content.includes("pg_isready")) {
    return;
  }

  const healthcheck = [
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U ${ENVIO_PG_USER:-postgres} -d ${ENVIO_PG_DATABASE:-envio-dev}"]',
    "      interval: 5s",
    "      timeout: 2s",
    "      retries: 10",
    "      start_period: 5s",
  ].join("\n");

  // Insert the healthcheck block just before the `networks:` line of the
  // envio-postgres service. The generated file always has this structure.
  const patched = content.replace(
    /^( {4}networks:\n {6}- my-proxy-net\n {2}graphql-engine:)/m,
    `${healthcheck}\n$1`,
  );

  if (patched !== content) {
    writeFileSync(composePath, patched, "utf8");
    console.log(
      "[run-envio-with-env] Patched docker-compose.yaml: added postgres healthcheck",
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
        patchDockerComposeHealthcheck();
        process.exit(retryResult.status ?? 1);
      }
    }
    patchDockerComposeHealthcheck();
  }

  process.exit(result.status ?? 1);
};

main();
