#!/usr/bin/env node

/**
 * Agent-visible client for the root-owned local GitHub App broker.
 *
 * The client validates the request, verifies the installed trust root, and
 * invokes that broker with a clean environment. The broker owns token minting
 * and execution. No token crosses into this process.
 */

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROKER_INSTALL_PATH,
  BROKER_MODULE_INSTALL_PATH,
  BROKER_NODE_PATH,
  BROKER_NODE_ROOT,
  BROKER_OPERATION_CWD,
  BROKER_OS_USER,
  BROKER_POLICY_INSTALL_PATH,
  GCLOUD_PATH,
  GCLOUD_PYTHON_PATH,
  GCLOUD_PYTHON_ROOT,
  GCLOUD_SDK_ROOT,
} from "./local-agent-github-broker.mjs";
import {
  ClientFailure,
  assertNoAmbientGithubCredential,
  clientFailureMessage,
  parseClientArgs,
} from "./local-agent-github-command-policy.mjs";

export {
  assertNoAmbientGithubCredential,
  clientFailureMessage,
  parseClientArgs,
  parseStructuredOperation,
} from "./local-agent-github-command-policy.mjs";

const EXEC_ENV = Object.freeze({ ...process.env });
const SUDO_PATH = "/usr/bin/sudo";
const BROKER_SOURCE_PATH = fileURLToPath(
  new URL("./local-agent-github-broker.mjs", import.meta.url),
);
const BROKER_POLICY_SOURCE_PATH = fileURLToPath(
  new URL("./local-agent-github-command-policy.mjs", import.meta.url),
);
const BROKER_LAUNCHER_SOURCE_PATH = fileURLToPath(
  new URL("./local-agent-github-launcher.mjs", import.meta.url),
);
const TRUSTED_EXECUTABLE_DIRECTORIES = Object.freeze([
  "/usr/local",
  "/usr/local/libexec",
  BROKER_NODE_ROOT,
  `${BROKER_NODE_ROOT}/bin`,
  GCLOUD_SDK_ROOT,
  `${GCLOUD_SDK_ROOT}/bin`,
  GCLOUD_PYTHON_ROOT,
  `${GCLOUD_PYTHON_ROOT}/bin`,
  "/var/lib/mento-github-broker",
  BROKER_OPERATION_CWD,
]);

function fail(message) {
  throw new ClientFailure(message);
}

function brokerProcessEnv() {
  return { LANG: "C", LC_ALL: "C" };
}

function safeFileStat(value) {
  return (
    value.isFile() &&
    value.isSymbolicLink?.() !== true &&
    value.uid === 0 &&
    (value.mode & 0o022) === 0
  );
}

function safeDirectoryStat(value) {
  return (
    value.isDirectory() &&
    value.isSymbolicLink?.() !== true &&
    value.uid === 0 &&
    (value.mode & 0o022) === 0
  );
}

export async function verifyInstalledBroker({
  read = readFile,
  inspect = lstat,
} = {}) {
  const filePaths = [
    BROKER_INSTALL_PATH,
    BROKER_MODULE_INSTALL_PATH,
    BROKER_POLICY_INSTALL_PATH,
    BROKER_NODE_PATH,
    GCLOUD_PATH,
    GCLOUD_PYTHON_PATH,
  ];
  let fileStats;
  let directoryStats;
  let installedBytes;
  let sourceBytes;
  try {
    [fileStats, directoryStats, installedBytes, sourceBytes] =
      await Promise.all([
        Promise.all(filePaths.map((value) => inspect(value))),
        Promise.all(
          TRUSTED_EXECUTABLE_DIRECTORIES.map((value) => inspect(value)),
        ),
        Promise.all(
          [
            BROKER_INSTALL_PATH,
            BROKER_MODULE_INSTALL_PATH,
            BROKER_POLICY_INSTALL_PATH,
          ].map((value) => read(value)),
        ),
        Promise.all(
          [
            BROKER_LAUNCHER_SOURCE_PATH,
            BROKER_SOURCE_PATH,
            BROKER_POLICY_SOURCE_PATH,
          ].map((value) => read(value)),
        ),
      ]);
  } catch {
    fail("the root-owned host broker is not installed");
  }
  if (fileStats.some((value) => !safeFileStat(value))) {
    fail("a host broker executable or module ownership/mode is unsafe");
  }
  if (directoryStats.some((value) => !safeDirectoryStat(value))) {
    fail("a host broker directory ownership/mode is unsafe");
  }
  if (
    installedBytes.some(
      (value, index) =>
        !Buffer.from(value).equals(Buffer.from(sourceBytes[index])),
    )
  ) {
    fail("the installed host broker does not match the reviewed source");
  }
}

function spawnInherited(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });
}

export async function invokeInstalledBroker(
  options,
  { runProcess = spawnInherited, verifyBroker = verifyInstalledBroker } = {},
) {
  await verifyBroker();
  const args = [
    "-n",
    "-u",
    BROKER_OS_USER,
    BROKER_INSTALL_PATH,
    "--app-id",
    String(options.appId),
    "--installation-id",
    String(options.installationId),
    "--profile",
    options.profile,
    "--",
    options.operation,
    ...options.args,
  ];
  try {
    return await runProcess(SUDO_PATH, args, {
      cwd: BROKER_OPERATION_CWD,
      env: brokerProcessEnv(),
      shell: false,
      stdio: "inherit",
    });
  } catch {
    fail("the installed host broker operation failed");
  }
}

export async function runClient(
  argv,
  { env = EXEC_ENV, invokeBroker = invokeInstalledBroker } = {},
) {
  assertNoAmbientGithubCredential(env);
  const options = parseClientArgs(argv, env);
  return await invokeBroker(options);
}

async function main() {
  try {
    process.exitCode = await runClient(process.argv.slice(2), {
      env: EXEC_ENV,
    });
  } catch (error) {
    const message = clientFailureMessage(error);
    process.stderr.write(`local-agent GitHub client failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
