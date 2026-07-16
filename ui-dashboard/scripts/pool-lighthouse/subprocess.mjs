import { spawn } from "node:child_process";
import { createServer } from "node:net";

const children = new Set();
let shutdownStarted = false;

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export async function findFreePort(excluded = []) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocatePort();
    if (port > 0 && !excluded.includes(port)) return port;
  }
  throw new Error(`Could not allocate a port avoiding ${excluded.join(", ")}`);
}

export function spawnChild(
  command,
  args,
  { cwd, env, stdio = "inherit" } = {},
) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    env,
    stdio,
    detached,
    shell: false,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveExit({ code: code ?? 1, signal });
    });
  });
}

export async function runCommand(
  command,
  args,
  { cwd, env, allowFailure = false } = {},
) {
  const child = spawnChild(command, args, { cwd, env });
  const result = await childExit(child);
  if (!allowFailure && result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}${
        result.signal ? ` (${result.signal})` : ""
      }`,
    );
  }
  return result.code;
}

function signalChild(child, signal) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopChild(child) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  const exited = childExit(child).catch(() => ({ code: 1, signal: null }));
  signalChild(child, "SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 4000)),
  ]);
  if (!graceful) {
    signalChild(child, "SIGKILL");
    await exited;
  }
}

export async function stopAllChildren() {
  await Promise.allSettled([...children].map((child) => stopChild(child)));
}

export function installSignalHandlers() {
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      process.exitCode = exitCode;
      void stopAllChildren().finally(() => process.exit(exitCode));
    });
  }
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export async function waitForUrl(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${url} server exited before becoming ready`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (response.status < 500) return;
    } catch {
      // Keep polling until the child starts or the deadline expires.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
