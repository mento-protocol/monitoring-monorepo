#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UPSTASH_MCP_VERSION = "0.2.4";
export const UPSTASH_MCP_ENTRYPOINT_SHA256 =
  "1949e38e9c66aaac5cc00e2da2b8bbf712a4c39266f8f501a3cdd86253fe4b8e";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(SCRIPT_DIR, ".."));
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(pathFromParent)
  );
}

export function verifyUpstashMcpEntrypoint({
  repoRoot = REPO_ROOT,
  expectedVersion = UPSTASH_MCP_VERSION,
  expectedSha256 = UPSTASH_MCP_ENTRYPOINT_SHA256,
} = {}) {
  const packageRoot = realpathSync(
    resolve(repoRoot, "node_modules/@upstash/mcp-server"),
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );

  if (
    packageJson.name !== "@upstash/mcp-server" ||
    packageJson.version !== expectedVersion ||
    packageJson.bin?.["mcp-server"] !== "dist/index.js"
  ) {
    throw new Error(
      `expected @upstash/mcp-server ${expectedVersion} with the reviewed entrypoint`,
    );
  }

  const entrypoint = realpathSync(
    resolve(packageRoot, packageJson.bin["mcp-server"]),
  );
  if (!isWithin(packageRoot, entrypoint)) {
    throw new Error("the Upstash MCP entrypoint escapes its installed package");
  }

  const sha256 = createHash("sha256")
    .update(readFileSync(entrypoint))
    .digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      "the Upstash MCP entrypoint does not match the reviewed artifact",
    );
  }

  return { entrypoint, sha256, version: packageJson.version };
}

export function createTerminationForwarder(parent = process) {
  let child;
  let forwardedSignal;
  let escalated = false;
  const handlers = new Map(
    TERMINATION_SIGNALS.map((signal) => [
      signal,
      () => {
        if (!forwardedSignal) {
          forwardedSignal = signal;
          child?.kill(signal);
          return;
        }
        if (escalated) return;
        escalated = true;
        child?.kill("SIGKILL");
      },
    ]),
  );

  for (const [signal, handler] of handlers) parent.on(signal, handler);

  return {
    attachChild(nextChild) {
      if (child) throw new Error("termination forwarder already has a child");
      child = nextChild;
      if (escalated) child.kill("SIGKILL");
      else if (forwardedSignal) child.kill(forwardedSignal);
    },
    cleanup() {
      for (const [signal, handler] of handlers) {
        parent.removeListener(signal, handler);
      }
    },
    getForwardedSignal() {
      return forwardedSignal;
    },
  };
}

export async function launchUpstashMcp() {
  const { entrypoint } = verifyUpstashMcpEntrypoint();

  await new Promise((resolveLaunch, rejectLaunch) => {
    const signalForwarding = createTerminationForwarder();
    let child;
    try {
      child = spawn(process.execPath, [entrypoint, "--disable-telemetry"], {
        env: process.env,
        stdio: "inherit",
      });
    } catch (error) {
      signalForwarding.cleanup();
      rejectLaunch(error);
      return;
    }
    let settled = false;

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signalForwarding.cleanup();
      rejectLaunch(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      signalForwarding.cleanup();
      const terminationSignal = signal ?? signalForwarding.getForwardedSignal();
      if (terminationSignal) {
        process.kill(process.pid, terminationSignal);
        return;
      }
      process.exitCode = code ?? 1;
      resolveLaunch();
    });
    signalForwarding.attachChild(child);
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  launchUpstashMcp().catch((error) => {
    console.error(`Refusing to start Upstash MCP: ${error.message}`);
    process.exitCode = 1;
  });
}
