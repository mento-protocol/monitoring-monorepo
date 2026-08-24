import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { socketPathForRoot } from "./quality-gate-coordinator-legacy.mjs";
import {
  DEFAULT_POLICY_HASH,
  PROTOCOL_VERSION,
} from "./quality-gate-coordinator-state.mjs";

export const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const WAIT_TRANSPORT_MARGIN_MS = 1_000;
const PARENT_LIFECYCLE_POLL_MS = 25;

export class CoordinatorRemoteError extends Error {
  constructor(error) {
    super(error?.message ?? "coordinator request failed");
    this.name = "CoordinatorRemoteError";
    this.code = error?.code ?? "REMOTE_ERROR";
    this.details = error?.details;
  }
}

export async function connectCoordinator({
  root,
  protocol = PROTOCOL_VERSION,
  policyHash = DEFAULT_POLICY_HASH,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
} = {}) {
  const socket = createConnection(socketPathForRoot(root));
  socket.setEncoding("utf8");
  await new Promise((resolveConnect, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new CoordinatorRemoteError({
          code: "TRANSPORT_TIMEOUT",
          message: "coordinator socket connect timed out",
        }),
      );
    }, rpcTimeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnect();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket.on("error", () => {});
  let input = "";
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const pending = new Map();
  socket.on("data", (chunk) => {
    input += chunk;
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.response);
      else waiter.reject(new CoordinatorRemoteError(message.error));
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new CoordinatorRemoteError({
          code: "CONNECTION_CLOSED",
          message: "coordinator connection closed",
        }),
      );
    }
    pending.clear();
    resolveClosed();
  });
  function request(action, params = {}) {
    if (closed || socket.destroyed) {
      return Promise.reject(
        new CoordinatorRemoteError({
          code: "CONNECTION_CLOSED",
          message: "connection is closed",
        }),
      );
    }
    const id = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      const waitMs = ["wait-result", "wait-admission", "wait-lease"].includes(
        action,
      )
        ? params.timeoutMs > 0
          ? params.timeoutMs + WAIT_TRANSPORT_MARGIN_MS
          : rpcTimeoutMs
        : rpcTimeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(
          new CoordinatorRemoteError({
            code: "TRANSPORT_TIMEOUT",
            message: `${action} did not receive a coordinator response`,
          }),
        );
        socket.destroy();
      }, waitMs);
      pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      socket.write(
        `${JSON.stringify({ id, protocol, policyHash, action, params })}\n`,
      );
    });
  }
  async function endSocket() {
    if (closed || socket.destroyed) return;
    await new Promise((resolveEnd) => {
      socket.once("close", resolveEnd);
      socket.end();
    });
  }
  async function close() {
    if (closed || socket.destroyed) return;
    try {
      await request("detach");
    } catch (error) {
      if (closed || socket.destroyed) return;
      await endSocket();
      throw error;
    }
    await endSocket();
  }
  return {
    socket,
    request,
    close,
    closed: closedPromise,
    destroy: () => socket.destroy(),
  };
}

export async function coordinatorRpc(options, action, params = {}) {
  const client = await connectCoordinator(options);
  try {
    return await client.request(action, params);
  } finally {
    await client.close();
  }
}

export async function bindCoordinatorRequest(
  options,
  params,
  { parentPid, publishResponse },
) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
    throw new CoordinatorRemoteError({
      code: "INVALID_ARGUMENT",
      message: "bound coordinator request requires a positive parent PID",
    });
  }
  if (typeof publishResponse !== "function") {
    throw new CoordinatorRemoteError({
      code: "INVALID_ARGUMENT",
      message: "bound coordinator request requires a response publisher",
    });
  }
  if (process.ppid !== parentPid) {
    throw new CoordinatorRemoteError({
      code: "OWNER_PARENT_CHANGED",
      message: "gate parent changed before coordinator registration",
    });
  }

  const client = await connectCoordinator(options);
  let lifecycleResolve;
  let lifecycleMode = null;
  const lifecycle = new Promise((resolveLifecycle) => {
    lifecycleResolve = resolveLifecycle;
  });
  const stop = (mode) => {
    if (lifecycleMode !== null) return;
    lifecycleMode = mode;
    lifecycleResolve(mode);
  };
  const onCleanStop = () => stop("clean");
  const onUncleanStop = () => stop("unclean");
  process.once("SIGUSR2", onCleanStop);
  process.once("SIGTERM", onUncleanStop);
  process.once("SIGINT", onUncleanStop);
  process.once("SIGHUP", onUncleanStop);
  const parentTimer = setInterval(() => {
    if (process.ppid !== parentPid) stop("unclean");
  }, PARENT_LIFECYCLE_POLL_MS);

  try {
    const response = await client.request("register", {
      ...params,
      bindConnection: true,
    });
    if (process.ppid !== parentPid) {
      client.destroy();
      throw new CoordinatorRemoteError({
        code: "OWNER_PARENT_CHANGED",
        message: "gate parent changed during coordinator registration",
      });
    }
    await publishResponse(response);
    const mode = await Promise.race([
      lifecycle,
      client.closed.then(() => "connection-closed"),
    ]);
    if (mode === "clean") await client.close();
    else if (mode !== "connection-closed") client.destroy();
    await client.closed;
    return response;
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    clearInterval(parentTimer);
    process.off("SIGUSR2", onCleanStop);
    process.off("SIGTERM", onUncleanStop);
    process.off("SIGINT", onUncleanStop);
    process.off("SIGHUP", onUncleanStop);
  }
}
