#!/usr/bin/env node

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function errorRecord(error) {
  return {
    code: error?.code ?? "COORDINATOR_LIFECYCLE_FAILED",
    message: error?.message ?? String(error),
  };
}

function publishCompletion(path, exitCode) {
  const updatePath = `${path}.tmp-${process.pid}`;
  const status = exitCode === 0 ? "stopped" : "failed";
  try {
    writeFileSync(updatePath, `${JSON.stringify({ status, exitCode })}\n`, {
      mode: 0o600,
    });
    renameSync(updatePath, path);
    return true;
  } catch (error) {
    try {
      unlinkSync(updatePath);
    } catch {
      // The original completion error is the useful diagnostic.
    }
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: errorRecord(error) })}\n`,
    );
    return false;
  }
}

async function main() {
  const [entrypoint, completionFile, ...args] = process.argv.slice(2);
  if (!entrypoint || !completionFile) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message:
            "lifecycle bootstrap requires entrypoint and completion paths",
        },
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  let exitCode;
  const signalExitCodes = new Map([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]);
  const signalHandlers = new Map();
  for (const [signal, signalExitCode] of signalExitCodes) {
    const handler = () => {
      publishCompletion(completionFile, signalExitCode);
      process.exit(signalExitCode);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const coordinator = await import(pathToFileURL(resolve(entrypoint)).href);
    if (typeof coordinator.runCli !== "function") {
      const error = new Error("coordinator entrypoint does not export runCli");
      error.code = "INVALID_COORDINATOR_ENTRYPOINT";
      throw error;
    }
    await coordinator.runCli(args);
    exitCode = 0;
  } catch (error) {
    exitCode = error?.code === "WAIT_TIMEOUT" ? 3 : 2;
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: errorRecord(error) })}\n`,
    );
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    if (!publishCompletion(completionFile, exitCode)) exitCode = 2;
    process.exitCode = exitCode;
  }
}

await main();
