import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function processRunning(pid) {
  try {
    const { stdout } = await run("ps", ["-o", "stat=", "-p", String(pid)]);
    const state = stdout.trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

export async function processStartUtc(pid) {
  try {
    const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim() || null;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

export async function identityMatches(identity) {
  const currentStart = await processStartUtc(identity.pid);
  return currentStart !== null && currentStart === identity.startUtc;
}

export async function childrenOf(pid) {
  const { stdout } = await run("pgrep", ["-P", String(pid)]).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  return stdout.trim().split(/\s+/u).filter(Boolean).map(Number);
}

async function parentOf(pid) {
  const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
  return Number(stdout.trim());
}

export async function directAncestor(descendantPid, rootPid) {
  let current = descendantPid;
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = await parentOf(current);
    if (parent === rootPid) return current;
    if (!Number.isInteger(parent) || parent <= 1 || parent === current) break;
    current = parent;
  }
  throw new Error(`${descendantPid} is not a descendant of ${rootPid}`);
}

async function waitUntilStopped(identities, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const matches = await Promise.all(identities.map(identityMatches));
    if (matches.every((match) => !match)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const live = [];
  for (const identity of identities) {
    if (await identityMatches(identity)) live.push(identity.pid);
  }
  throw new Error(`exact fixture processes did not exit: ${live.join(",")}`);
}

async function signalExact(identity, signal) {
  if (!(await identityMatches(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export class ExactFixtureProcesses {
  #identities = new Map();

  async track(pid) {
    if (this.#identities.has(pid)) return this.#identities.get(pid);
    const startUtc = await processStartUtc(pid);
    if (!startUtc)
      throw new Error(`cannot read fixture process identity: ${pid}`);
    const identity = { pid, startUtc };
    this.#identities.set(pid, identity);
    return identity;
  }

  async #trackTree(pid) {
    for (const child of await childrenOf(pid)) {
      const startUtc = await processStartUtc(child);
      if (!startUtc) continue;
      this.#identities.set(child, { pid: child, startUtc });
      await this.#trackTree(child);
    }
  }

  async allStopped() {
    const matches = await Promise.all(
      [...this.#identities.values()].map(identityMatches),
    );
    return matches.every((match) => !match);
  }

  async stopAll() {
    const roots = [...this.#identities.values()];
    // Freeze every known root before the tree walk. The fixture's Bash loop
    // can otherwise replace its `sleep` child between capture and teardown.
    for (const identity of roots) {
      await signalExact(identity, "SIGSTOP");
    }
    for (const identity of roots) {
      if (await identityMatches(identity)) await this.#trackTree(identity.pid);
    }
    const identities = [...this.#identities.values()].reverse();
    for (const identity of identities) {
      await signalExact(identity, "SIGKILL");
    }
    await waitUntilStopped(identities);
  }
}
