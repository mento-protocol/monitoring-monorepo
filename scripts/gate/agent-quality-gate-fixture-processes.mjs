import { execFile } from "node:child_process";
import { constants as osConstants } from "node:os";
import { promisify } from "node:util";

import {
  captureDarwinExactChild,
  parseDarwinExactIdentity,
  prepareDarwinExactIdentityHelper,
  signalDarwinExactIdentity,
  statusDarwinExactIdentity,
} from "./darwin-process-lineage.mjs";

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
  if (process.platform === "darwin" && identity.darwinExactIdentity) {
    const result = statusDarwinExactIdentity({
      scratchDirectory: identity.darwinScratchDirectory,
      exactIdentity: identity.darwinExactIdentity,
    });
    return result.status === "live";
  }
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
  try {
    const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    return Number(stdout.trim());
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
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
  if (process.platform === "darwin") {
    if (!identity.darwinExactIdentity || !identity.darwinScratchDirectory) {
      throw new Error(
        `Darwin fixture process has no exact audit-token identity: ${identity.pid}`,
      );
    }
    const signalNumber = osConstants.signals[signal];
    if (
      ![
        osConstants.signals.SIGSTOP,
        osConstants.signals.SIGTERM,
        osConstants.signals.SIGKILL,
      ].includes(signalNumber)
    ) {
      throw new Error(`unsupported exact fixture signal: ${signal}`);
    }
    const result = signalDarwinExactIdentity({
      scratchDirectory: identity.darwinScratchDirectory,
      exactIdentity: identity.darwinExactIdentity,
      signal: signalNumber,
    });
    return result.signalled;
  }
  if (!(await identityMatches(identity))) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export class ExactFixtureProcesses {
  #identities = new Map();
  #darwinScratchDirectory;
  #rootParentPid = process.pid;

  constructor({ darwinScratchDirectory = "" } = {}) {
    if (
      process.platform === "darwin" &&
      (typeof darwinScratchDirectory !== "string" || !darwinScratchDirectory)
    ) {
      throw new Error(
        "Darwin fixture cleanup requires a helper scratch directory",
      );
    }
    this.#darwinScratchDirectory = darwinScratchDirectory;
    if (process.platform === "darwin") {
      prepareDarwinExactIdentityHelper({
        scratchDirectory: this.#darwinScratchDirectory,
      });
    }
  }

  async track(pid, { allowMissing = false, parentPid = null } = {}) {
    if (process.platform === "darwin") {
      if (!Number.isInteger(parentPid) || parentPid < 1) {
        throw new Error(
          `Darwin fixture process requires an explicit parent: ${pid}`,
        );
      }
      const existing = this.#identities.get(pid);
      if (existing) {
        if (existing.parentPid !== parentPid) {
          throw new Error(
            `Darwin fixture process parent changed after capture: ${pid}`,
          );
        }
        return existing;
      }
    } else if (this.#identities.has(pid)) {
      return this.#identities.get(pid);
    }
    const startUtc = await processStartUtc(pid);
    if (!startUtc && allowMissing) return null;
    if (!startUtc) {
      throw new Error(`cannot read fixture process identity: ${pid}`);
    }
    const identity = { pid, startUtc };
    if (process.platform === "darwin") {
      const parentIdentity = this.#identities.get(parentPid);
      if (!parentIdentity && parentPid !== this.#rootParentPid) {
        throw new Error(
          `Darwin fixture parent is outside the tracked fixture tree: ${parentPid}`,
        );
      }
      let captured;
      try {
        captured = captureDarwinExactChild({
          scratchDirectory: this.#darwinScratchDirectory,
          pid,
          parentPid,
        });
      } catch (error) {
        if (allowMissing && !(await processRunning(pid))) return null;
        throw error;
      }
      if (!captured.active || !captured.identity) {
        throw new Error(`cannot capture exact Darwin fixture identity: ${pid}`);
      }
      if (parentIdentity) {
        const childExact = parseDarwinExactIdentity(captured.identity);
        const parentExact = parseDarwinExactIdentity(
          parentIdentity.darwinExactIdentity,
        );
        if (
          childExact.bootId !== parentExact.bootId ||
          childExact.parentUniqueId !== parentExact.uniqueId
        ) {
          throw new Error(
            `Darwin fixture child is not bound to its tracked parent: ${pid}`,
          );
        }
      }
      identity.darwinExactIdentity = captured.identity;
      identity.darwinScratchDirectory = this.#darwinScratchDirectory;
      identity.parentPid = parentPid;
    }
    this.#identities.set(pid, identity);
    return identity;
  }

  async trackDescendant(pid, rootIdentity) {
    if (this.#identities.get(rootIdentity?.pid) !== rootIdentity) {
      throw new Error("fixture descendant root is not tracked");
    }
    if (pid === rootIdentity.pid) return rootIdentity;
    const lineage = [];
    let current = pid;
    for (let depth = 0; depth < 32; depth += 1) {
      const parentPid = await parentOf(current);
      if (!Number.isInteger(parentPid) || parentPid <= 1) break;
      lineage.push({ pid: current, parentPid });
      if (parentPid === rootIdentity.pid) {
        let identity = rootIdentity;
        for (const edge of lineage.reverse()) {
          identity = await this.track(edge.pid, {
            parentPid: edge.parentPid,
          });
        }
        return identity;
      }
      current = parentPid;
    }
    throw new Error(`${pid} is not a descendant of ${rootIdentity.pid}`);
  }

  async signal(identity, signal) {
    return signalExact(identity, signal);
  }

  async #trackTree(pid) {
    for (const child of await childrenOf(pid)) {
      const identity = await this.track(child, {
        allowMissing: true,
        parentPid: pid,
      });
      if (!identity) continue;
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
