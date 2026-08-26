#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindCoordinatorRequest,
  coordinatorRpc,
} from "./quality-gate-coordinator-client.mjs";
import {
  assertEffectiveCoordinatorPolicy,
  coordinatorAdapterHashes,
  coordinatorNodeRuntimeHash,
  coordinatorSourceSignature,
  createCoordinatorPolicyAttestor,
  effectiveCoordinatorPolicyHash,
} from "./quality-gate-coordinator-policy.mjs";
import { installCoordinatorRequestPolicyAttestor } from "./quality-gate-coordinator-socket.mjs";
import {
  CoordinatorError,
  DEFAULT_CAPACITY,
  DEFAULT_IDLE_MS,
  DEFAULT_POLICY_HASH,
  ensurePrivateDirectory,
  positiveInteger,
  writeAtomicJson,
} from "./quality-gate-coordinator-state.mjs";
import {
  removePublishedReadyMetadata,
  verifyDetachedCoordinatorReady,
} from "./quality-gate-coordinator-startup-attestation.mjs";
import {
  serializedError,
  startCoordinator,
} from "./quality-gate-coordinator-server.mjs";

export { QualityGateCoordinator } from "./quality-gate-coordinator-core.mjs";
export {
  CoordinatorRemoteError,
  DEFAULT_RPC_TIMEOUT_MS,
  connectCoordinator,
  coordinatorRpc,
} from "./quality-gate-coordinator-client.mjs";
export { RECORD_RETENTION_MS } from "./quality-gate-coordinator-retention.mjs";
export {
  LEGACY_RUN_LOCK_INTEGRATION,
  adoptLegacyRunLock,
  currentProcessIdentity,
  legacyOwnerRecordText,
  observeProcessIdentity,
  ownerFields,
  processStartUtc,
  socketPathForRoot,
} from "./quality-gate-coordinator-legacy.mjs";
export {
  CoordinatorError,
  DEFAULT_CAPACITY,
  DEFAULT_IDLE_MS,
  DEFAULT_POLICY_HASH,
  PROTOCOL_VERSION,
  fingerprintHash,
} from "./quality-gate-coordinator-state.mjs";
export {
  startCoordinator,
  stateNamespace,
} from "./quality-gate-coordinator-server.mjs";

const MAX_COORDINATOR_LOG_BYTES = 1024 * 1024;

export function serveChildEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.AGENT_QUALITY_GATE_REQUEST_CAPABILITY;
  return sanitized;
}

function defaultRoot() {
  return process.env.HOME
    ? join(process.env.HOME, ".cache", "agent-quality-gate", "coordinator-v1")
    : join(tmpdir(), `agent-quality-gate-${process.getuid?.() ?? "user"}`);
}

function parseCli(argv) {
  const command = argv[0];
  if (!command || ["-h", "--help"].includes(command)) return { help: true };
  const values = new Map();
  const resources = [];
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      ["--all-capacity", "--bind-connection", "--command-not-started"].includes(
        arg,
      )
    ) {
      flags.add(arg);
      continue;
    }
    if (!arg.startsWith("--") || argv[index + 1] === undefined) {
      throw new CoordinatorError("INVALID_ARGUMENT", `${arg} requires a value`);
    }
    const value = argv[++index];
    if (arg === "--resource") resources.push(value);
    else values.set(arg, value);
  }
  return { command, values, resources, flags, help: false };
}

function required(parsed, key) {
  const value = parsed.values.get(key);
  if (!value)
    throw new CoordinatorError("INVALID_ARGUMENT", `${key} is required`);
  return value;
}

function integer(parsed, key, fallback) {
  const value = parsed.values.get(key);
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${key} requires an integer`,
    );
  }
  return Number(value);
}

function loadedAdapterHashes(parsed) {
  const main = parsed.values.get("--loaded-adapter-main-hash");
  const support = parsed.values.get("--loaded-adapter-support-hash");
  if (main === undefined && support === undefined) return undefined;
  if (main === undefined || support === undefined) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "both loaded adapter hashes are required",
    );
  }
  return { main, support };
}

function owner(parsed, prefix = "owner") {
  return {
    pid: integer(parsed, `--${prefix}-pid`),
    startUtc: required(parsed, `--${prefix}-start-utc`),
  };
}

function requestCapability() {
  const capability = process.env.AGENT_QUALITY_GATE_REQUEST_CAPABILITY;
  if (!/^[a-f0-9]{64}$/u.test(capability ?? "")) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "AGENT_QUALITY_GATE_REQUEST_CAPABILITY must be 32 random bytes encoded as lowercase hexadecimal",
    );
  }
  return capability;
}

function json(parsed, key, fallback) {
  const value = parsed.values.get(key);
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      `${key} is invalid JSON: ${error.message}`,
    );
  }
}

function childServeArguments(argv, readyFile, policyHash) {
  const forwarded = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (
      argv[index] === "--startup-timeout-ms" ||
      argv[index] === "--policy-hash"
    ) {
      index += 1;
      continue;
    }
    forwarded.push(argv[index]);
  }
  return [
    "serve",
    ...forwarded,
    "--policy-hash",
    policyHash,
    "--ready-file",
    readyFile,
  ];
}

async function terminateSpawnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const waitForExit = (timeoutMs) =>
    new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit(true);
        return;
      }
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolveExit(false);
      }, timeoutMs);
      function onExit() {
        clearTimeout(timer);
        resolveExit(true);
      }
      child.once("exit", onExit);
    });
  child.kill("SIGTERM");
  if (await waitForExit(500)) return;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await waitForExit(2_000);
  if (child.exitCode === null && child.signalCode === null) {
    throw new CoordinatorError(
      "COORDINATOR_CHILD_STILL_LIVE",
      `could not reap detached coordinator child ${child.pid}`,
    );
  }
}

export async function startDetached(
  parsed,
  argv,
  policyHash,
  { spawnChild = spawn } = {},
) {
  const root = parsed.values.get("--root") ?? defaultRoot();
  const capacity = integer(parsed, "--capacity", DEFAULT_CAPACITY);
  const requireLegacyAuthority = Boolean(
    parsed.values.get("--legacy-lock-root"),
  );
  ensurePrivateDirectory(root);
  const readyFile = join(root, `ready.${randomUUID()}.json`);
  const logPath = join(root, "coordinator.log");
  if (
    existsSync(logPath) &&
    statSync(logPath).size > MAX_COORDINATOR_LOG_BYTES
  ) {
    const rotated = `${logPath}.1`;
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(logPath, rotated);
  }
  const logDescriptor = openSync(logPath, "a", 0o600);
  let spawnError = null;
  const child = spawnChild(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      ...childServeArguments(argv, readyFile, policyHash),
    ],
    {
      detached: true,
      env: serveChildEnvironment(),
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  closeSync(logDescriptor);
  const deadline = Date.now() + integer(parsed, "--startup-timeout-ms", 10_000);
  let readyError = null;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      try {
        const metadata = await verifyDetachedCoordinatorReady({
          readyFile,
          root,
          policyHash,
          capacity,
          childPid: child.pid,
          requireLegacyAuthority,
          rpcTimeoutMs: Math.max(1, Math.min(250, deadline - Date.now())),
        });
        if (metadata) {
          const cleanup = removePublishedReadyMetadata({
            paths: [readyFile],
            metadata,
          });
          if (cleanup.retained.length) {
            throw new CoordinatorError(
              "COORDINATOR_READY_MISMATCH",
              "verified ready metadata changed before cleanup",
            );
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new CoordinatorError(
              "COORDINATOR_START_FAILED",
              "detached coordinator exited after its ready handshake",
            );
          }
          child.unref();
          return metadata;
        }
      } catch (error) {
        readyError = error;
        if (error.code === "COORDINATOR_READY_MISMATCH") break;
      }
    }
    if (spawnError) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      process.kill(child.pid, 0);
    } catch {
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  await terminateSpawnedChild(child);
  if (existsSync(readyFile)) unlinkSync(readyFile);
  throw new CoordinatorError(
    "COORDINATOR_START_FAILED",
    `detached coordinator did not become ready; see ${logPath}`,
    {
      childPid: child.pid ?? null,
      cause: spawnError?.message ?? readyError?.message,
      terminated: true,
    },
  );
}

function usage() {
  return `Usage: quality-gate-coordinator.mjs <adapter-hashes|policy-hash|source-signature|runtime-hash|node-policy-hash|start|serve|authority|register|wait-admission|lease|wait-lease|release|abandon-lease|result|wait-result|ack-result|cancel|claim-drain|release-drain-claim|ack-drain|status> [options]\n`;
}

function commonOwnerParams(parsed) {
  return {
    requestId: required(parsed, "--request-id"),
    owner: owner(parsed),
    capability: requestCapability(),
  };
}

export async function runCli(argv) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (parsed.command === "node-policy-hash") {
    process.stdout.write(DEFAULT_POLICY_HASH);
    return;
  }
  if (parsed.command === "adapter-hashes") {
    const hashes = coordinatorAdapterHashes();
    process.stdout.write(`${hashes.main} ${hashes.support}`);
    return;
  }
  if (parsed.command === "runtime-hash") {
    process.stdout.write(coordinatorNodeRuntimeHash());
    return;
  }
  if (parsed.command === "source-signature") {
    process.stdout.write(coordinatorSourceSignature());
    return;
  }
  if (parsed.command === "policy-hash") {
    const capacity = integer(parsed, "--capacity", DEFAULT_CAPACITY);
    process.stdout.write(
      effectiveCoordinatorPolicyHash(capacity, {
        loadedAdapterHashes: loadedAdapterHashes(parsed),
      }),
    );
    return;
  }
  if (parsed.command === "start") {
    const capacity = integer(parsed, "--capacity", DEFAULT_CAPACITY);
    positiveInteger(capacity, "capacity");
    const suppliedPolicyHash = parsed.values.get("--policy-hash");
    const policyHash = suppliedPolicyHash
      ? assertEffectiveCoordinatorPolicy(suppliedPolicyHash, capacity)
      : effectiveCoordinatorPolicyHash(capacity);
    process.stdout.write(
      `${JSON.stringify(await startDetached(parsed, argv, policyHash))}\n`,
    );
    return;
  }
  if (parsed.command === "serve") {
    const capacity = integer(parsed, "--capacity", DEFAULT_CAPACITY);
    const suppliedPolicyHash = required(parsed, "--policy-hash");
    const sourceAttestor = createCoordinatorPolicyAttestor(
      suppliedPolicyHash,
      capacity,
    );
    const policyHash = suppliedPolicyHash;
    installCoordinatorRequestPolicyAttestor(sourceAttestor);
    if (Object.hasOwn(process.env, "AGENT_QUALITY_GATE_REQUEST_CAPABILITY")) {
      throw new CoordinatorError(
        "REQUEST_CAPABILITY_ENV_LEAK",
        "the detached coordinator must not inherit a request capability",
      );
    }
    const root = parsed.values.get("--root") ?? defaultRoot();
    const legacyOwnerId = parsed.values.get("--legacy-owner-token") ?? null;
    const legacyMachineIdentity =
      parsed.values.get("--legacy-machine-identity") ?? "";
    const coordinator = await startCoordinator({
      root,
      policyHash,
      capacity,
      idleMs: integer(parsed, "--idle-ms", DEFAULT_IDLE_MS),
      ownerSweepMs: integer(parsed, "--owner-sweep-ms", 1_000),
      legacyLockRoot: parsed.values.get("--legacy-lock-root") ?? null,
      legacyOwnerToken: legacyOwnerId,
      legacyMachineIdentity,
      readyFile: parsed.values.get("--ready-file") ?? null,
      sourceAttestor,
    });
    process.stdout.write(`${JSON.stringify(coordinator.metadata)}\n`);
    process.on("SIGHUP", () => {});
    const stop = () => void coordinator.close("signal");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await coordinator.closed;
    return;
  }
  const root = parsed.values.get("--root") ?? defaultRoot();
  const policyHash = parsed.values.get("--policy-hash") ?? DEFAULT_POLICY_HASH;

  let action;
  let params = {};
  switch (parsed.command) {
    case "authority":
      action = "authority";
      break;
    case "status":
      action = "inspect";
      break;
    case "register": {
      const drainId = required(parsed, "--drain-token");
      action = "register";
      params = {
        ...commonOwnerParams(parsed),
        fingerprint: required(parsed, "--fingerprint"),
        worktreeKey: required(parsed, "--worktree-key"),
        drainIdentity: drainId,
        successMaxAgeMs: integer(parsed, "--success-max-age-ms", 0),
        metadata: json(parsed, "--metadata-json", {}),
        bindConnection: parsed.flags.has("--bind-connection"),
      };
      break;
    }
    case "wait-admission":
      action = "wait-admission";
      params = {
        ...commonOwnerParams(parsed),
        timeoutMs: integer(parsed, "--timeout-ms", 0),
      };
      break;
    case "lease":
      action = "request-lease";
      params = {
        ...commonOwnerParams(parsed),
        leaseId: required(parsed, "--lease-id"),
        drainIdentity: required(parsed, "--drain-token"),
        weight: integer(parsed, "--weight", 1),
        allCapacity: parsed.flags.has("--all-capacity"),
        resources: parsed.resources,
        metadata: json(parsed, "--metadata-json", {}),
      };
      break;
    case "wait-lease":
      action = "wait-lease";
      params = {
        leaseId: required(parsed, "--lease-id"),
        owner: owner(parsed),
        capability: requestCapability(),
        timeoutMs: integer(parsed, "--timeout-ms", 0),
      };
      break;
    case "release":
      action = "release-lease";
      params = {
        ...commonOwnerParams(parsed),
        leaseId: required(parsed, "--lease-id"),
      };
      break;
    case "abandon-lease":
      if (!parsed.flags.has("--command-not-started")) {
        throw new CoordinatorError(
          "INVALID_ARGUMENT",
          "abandon-lease requires --command-not-started",
        );
      }
      action = "abandon-lease";
      params = {
        ...commonOwnerParams(parsed),
        leaseId: required(parsed, "--lease-id"),
        commandStarted: false,
      };
      break;
    case "result":
      action = "publish-result";
      params = {
        ...commonOwnerParams(parsed),
        status: required(parsed, "--status"),
        payload: json(parsed, "--payload-json", null),
      };
      break;
    case "wait-result":
      action = "wait-result";
      params = {
        ...commonOwnerParams(parsed),
        fingerprint: required(parsed, "--fingerprint"),
        executionId: required(parsed, "--execution-id"),
        timeoutMs: integer(parsed, "--timeout-ms", 0),
      };
      break;
    case "ack-result":
      action = "acknowledge-result";
      params = commonOwnerParams(parsed);
      break;
    case "cancel":
      action = "cancel-request";
      params = {
        ...commonOwnerParams(parsed),
        reason: parsed.values.get("--reason") ?? "cancelled",
      };
      break;
    case "ack-drain": {
      const drainId = required(parsed, "--drain-token");
      action = "acknowledge-drain";
      params = {
        obligationId: required(parsed, "--obligation-id"),
        drainIdentity: drainId,
        drainer: owner(parsed, "drainer"),
        evidence: json(parsed, "--evidence-json", {}),
      };
      break;
    }
    case "claim-drain":
    case "release-drain-claim": {
      const drainId = required(parsed, "--drain-token");
      action =
        parsed.command === "claim-drain"
          ? "claim-drain"
          : "release-drain-claim";
      params = {
        obligationId: required(parsed, "--obligation-id"),
        drainIdentity: drainId,
        claimant: owner(parsed, "claimant"),
      };
      break;
    }
    default:
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        `unknown command: ${parsed.command}`,
      );
  }
  if (action === "register" && params.bindConnection === true) {
    const responseFile = required(parsed, "--response-file");
    const lifecycleControlFile = required(parsed, "--lifecycle-control-file");
    const parentPid = integer(parsed, "--parent-pid");
    await bindCoordinatorRequest({ root, policyHash }, params, {
      parentPid,
      lifecycleControlFile,
      publishResponse(response) {
        writeAtomicJson(responseFile, response);
      },
    });
    return;
  }
  const response = await coordinatorRpc(
    {
      root,
      policyHash,
      cancellationFile: parsed.values.get("--cancel-file"),
    },
    action,
    params,
  );
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: serializedError(error) })}\n`,
    );
    process.exitCode = error.code === "WAIT_TIMEOUT" ? 3 : 2;
  });
}
