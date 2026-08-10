#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UPSTASH_MCP_VERSION = "0.2.4";
export const UPSTASH_MCP_ENTRYPOINT_SHA256 =
  "1949e38e9c66aaac5cc00e2da2b8bbf712a4c39266f8f501a3cdd86253fe4b8e";
export const UPSTASH_MCP_RUNTIME_SHA256 =
  "c6770a6008cfb5946a4e87385c6f61aa1166fff0614d541789949cb577ce09b6";
export const UPSTASH_MCP_RUNTIME_LOADER = [
  'import { readFileSync } from "node:fs";',
  'process.argv.splice(1, 0, "upstash-mcp-runtime.mjs");',
  "const runtimeBytes = readFileSync(3);",
  'const runtimeUrl = `data:text/javascript;base64,${runtimeBytes.toString("base64")}`;',
  "await import(runtimeUrl);",
].join("\n");

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function defaultRepoRoot() {
  return realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

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
  repoRoot = defaultRepoRoot(),
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

export function verifyUpstashMcpRuntime({
  runtimePath,
  expectedSha256 = UPSTASH_MCP_RUNTIME_SHA256,
}) {
  if (typeof runtimePath !== "string" || !isAbsolute(runtimePath)) {
    throw new Error("the personal Upstash MCP runtime path must be absolute");
  }
  const bytes = readFileSync(runtimePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      "the personal Upstash MCP runtime does not match the reviewed bundle",
    );
  }
  return { bytes, sha256 };
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

export async function launchUpstashMcp({ runtimePath } = {}) {
  const { bytes: runtimeBytes } = verifyUpstashMcpRuntime({ runtimePath });

  await new Promise((resolveLaunch, rejectLaunch) => {
    const signalForwarding = createTerminationForwarder();
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          UPSTASH_MCP_RUNTIME_LOADER,
          "--",
          "--disable-telemetry",
        ],
        {
          env: process.env,
          stdio: ["inherit", "inherit", "inherit", "pipe"],
        },
      );
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
    child.stdio[3].once("error", (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      signalForwarding.cleanup();
      rejectLaunch(error);
    });
    signalForwarding.attachChild(child);
    child.stdio[3].end(runtimeBytes);
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
