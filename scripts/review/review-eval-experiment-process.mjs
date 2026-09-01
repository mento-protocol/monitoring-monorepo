// Bounded model processes for the non-ledger experiment runner.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { claudeArgv } from "./review-eval-run-execution.mjs";

export const EXPERIMENT_CALL_TIMEOUT_MS = 60 * 60 * 1000;
export const EXPERIMENT_STAGE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const GROUP_SETTLE_POLL_MS = 25;
const activeProcesses = new Set();

function isScriptLauncher(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
}

/** Resolve and pin a direct provider executable, never an unsealed script shim. */
export function resolveExperimentExecutable({ name, env }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name ?? ""))) {
    throw new Error("experiment executable name is invalid");
  }
  for (const entry of String(env?.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const executable = realpathSync(candidate);
    const bytes = readFileSync(executable);
    if (isScriptLauncher(bytes)) continue;
    const probe = spawnSync(executable, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `${name} version probe failed: ${probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`}`,
      );
    }
    const version = String(probe.stdout).trim();
    if (!version) throw new Error(`${name} version probe returned no output`);
    return {
      name,
      path: executable,
      digest: createHash("sha256").update(bytes).digest("hex"),
      version,
    };
  }
  throw new Error(
    `${name} has no direct provider executable on the scrubbed PATH; script launchers are not valid experiment identities`,
  );
}

function processGroupSignal(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The process already exited or cannot receive the signal.
      }
    }
  }
}

function processGroupExists(child) {
  if (!child.pid || process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("experiment model call was aborted");
}

/** Run one command in its own process group and kill the whole group on stop. */
export function spawnExperimentProcess({
  file,
  args,
  cwd,
  env,
  input = null,
  timeoutMs = EXPERIMENT_CALL_TIMEOUT_MS,
  signal = null,
}) {
  const operation = new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(file, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError = null;
    let terminationTimer = null;

    const removeAbort = () => signal?.removeEventListener("abort", onAbort);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      removeAbort();
      if (error) reject(error);
      else resolve(value);
    };
    const settleKilledGroup = (error, value) => {
      processGroupSignal(child, "SIGKILL");
      if (process.platform === "win32") {
        finish(error, value);
        return;
      }
      const settleStarted = Date.now();
      const poll = () => {
        let exists;
        try {
          exists = processGroupExists(child);
        } catch (groupError) {
          finish(
            new Error(
              `${file} process-group settlement failed: ${groupError.message}`,
            ),
          );
          return;
        }
        if (!exists) {
          finish(error, value);
          return;
        }
        if (Date.now() - settleStarted >= TERMINATION_GRACE_MS) {
          finish(
            new Error(`${file} process group did not settle after SIGKILL`),
          );
          return;
        }
        setTimeout(poll, GROUP_SETTLE_POLL_MS);
      };
      poll();
    };
    const terminate = (error) => {
      if (terminationError || settled) return;
      terminationError = error;
      processGroupSignal(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        settleKilledGroup(terminationError);
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => terminate(abortError(signal));
    const deadlineTimer = setTimeout(
      () =>
        terminate(new Error(`${file} did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    if (input !== null) {
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") {
          terminate(new Error(`${file} stdin failed: ${error.message}`));
        }
      });
      child.stdin.end(input);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_CHARS) {
        terminate(
          new Error(`${file} wrote more than ${MAX_OUTPUT_CHARS} chars`),
        );
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(terminationTimer);
      finish(new Error(`${file} could not start: ${error.message}`));
    });
    child.on("close", (code, childSignal) => {
      if (terminationError) return;
      clearTimeout(terminationTimer);
      if (code === 0) {
        settleKilledGroup(null, { stdout, stderr });
      } else {
        settleKilledGroup(
          new Error(
            `${file} exited ${code ?? childSignal}: ${stderr.slice(-400)}`,
          ),
        );
      }
    });
  });
  activeProcesses.add(operation);
  return operation.finally(() => activeProcesses.delete(operation));
}

/** Build Claude print-mode arguments that read all prompt bytes from stdin. */
export function claudeStdinArgv(request) {
  const argv = claudeArgv({ ...request, prompt: "" });
  if (argv[0] !== "-p" || argv[1] !== "") {
    throw new Error("Claude argument construction changed unexpectedly");
  }
  return ["-p", ...argv.slice(2), "--no-session-persistence"];
}

/** Wait until every process group has exited or received the final kill. */
export async function drainExperimentProcesses() {
  await Promise.allSettled([...activeProcesses]);
}

/** Adapt the bounded process runner to the scorer's injected Claude seam. */
export function createBoundedClaudeExec({ file, env, timeoutMs, signal }) {
  return async (request) => {
    const response = await spawnExperimentProcess({
      file,
      args: claudeStdinArgv(request),
      cwd: request.cwd ?? process.cwd(),
      env,
      input: request.prompt,
      timeoutMs,
      signal,
    });
    return response.stdout;
  };
}
