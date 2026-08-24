import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";

import {
  CoordinatorError,
  PROTOCOL_VERSION,
} from "./quality-gate-coordinator-state.mjs";

const maximumMessageBytes = 1024 * 1024;
let installedRequestPolicyAttestor = null;

export function installCoordinatorRequestPolicyAttestor(attestor) {
  if (typeof attestor !== "function") {
    throw new CoordinatorError(
      "INVALID_ARGUMENT",
      "coordinator request policy attestor must be a function",
    );
  }
  if (installedRequestPolicyAttestor !== null) {
    throw new CoordinatorError(
      "POLICY_ATTESTOR_ALREADY_INSTALLED",
      "coordinator request policy attestor is already installed",
    );
  }
  installedRequestPolicyAttestor = attestor;
}

function assertEnvelope(message, policyHash) {
  if (
    !message ||
    typeof message !== "object" ||
    typeof message.id !== "string"
  ) {
    throw new CoordinatorError("INVALID_MESSAGE", "message must have an id");
  }
  if (message.protocol?.major !== PROTOCOL_VERSION.major) {
    throw new CoordinatorError(
      "PROTOCOL_MAJOR_MISMATCH",
      "protocol major differs",
    );
  }
  if (
    !Number.isSafeInteger(message.protocol?.minor) ||
    message.protocol.minor < 0 ||
    message.protocol.minor > PROTOCOL_VERSION.minor
  ) {
    throw new CoordinatorError(
      "PROTOCOL_MINOR_MISMATCH",
      "protocol minor is newer",
    );
  }
  if (message.policyHash !== policyHash) {
    throw new CoordinatorError(
      "POLICY_MISMATCH",
      "scheduler policy hash differs",
    );
  }
  if (typeof message.action !== "string") {
    throw new CoordinatorError(
      "INVALID_MESSAGE",
      "message must have an action",
    );
  }
}

export function serializedError(error) {
  return error instanceof CoordinatorError || typeof error?.code === "string"
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "INTERNAL_ERROR", message: error.message };
}

export function sendResponse(socket, id, response) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify({ id, ok: true, response })}\n`);
  }
}

export function failResponse(socket, id, error, afterSend = null) {
  if (socket.destroyed) return false;
  const payload = `${JSON.stringify({ id, ok: false, error: serializedError(error) })}\n`;
  if (afterSend) socket.end(payload, afterSend);
  else socket.write(payload);
  return true;
}

export function probeSocket(path) {
  return new Promise((resolveProbe) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveProbe(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
  });
}

export function rejectWhileStarting(socket) {
  socket.setEncoding("utf8");
  let timer = setTimeout(() => socket.destroy(), 1_000);
  socket.once("close", () => clearTimeout(timer));
  socket.once("data", (chunk) => {
    clearTimeout(timer);
    let id = "starting";
    try {
      id = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))).id ?? id;
    } catch {
      // Keep the fallback response ID for a partial or malformed request.
    }
    socket.end(
      `${JSON.stringify({
        id,
        ok: false,
        error: {
          code: "COORDINATOR_STARTING",
          message: "coordinator has not acquired legacy authority",
        },
      })}\n`,
    );
    timer = setTimeout(() => socket.destroy(), 1_000);
  });
}

export async function closeBoundServer(server, socketPath, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (existsSync(socketPath)) unlinkSync(socketPath);
}

export function createReadyConnection({
  isClosing,
  connections,
  bindings,
  clearIdleTimer,
  waiters,
  policyHash,
  evaluateWaiter,
  scheduleIdle,
  dispatch,
  assertResponseAuthority,
  respondWithError,
  runMaintenance,
  core,
  coordinatorIdentity,
}) {
  // The production entry point installs this once before server startup. Keep
  // the captured closure immutable for the full lifetime of this server.
  const requestPolicyAttestor = installedRequestPolicyAttestor;
  return (socket) => {
    if (isClosing()) {
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    connections.add(socket);
    bindings.set(connectionId, new Map());
    clearIdleTimer();
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (isClosing()) return;
      input += chunk;
      if (Buffer.byteLength(input) > maximumMessageBytes) {
        failResponse(
          socket,
          "oversize",
          new CoordinatorError("MESSAGE_TOO_LARGE", "message exceeds 1 MiB"),
        );
        socket.destroy();
        return;
      }
      while (input.includes("\n")) {
        if (isClosing()) return;
        const newline = input.indexOf("\n");
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
          assertEnvelope(message, policyHash);
          // Detach is transport cleanup. It must remain available after an
          // attestation failure so a client can close without changing request
          // state. Every other RPC attests before it can add a waiter, bind a
          // request, or dispatch a coordinator state transition.
          if (message.action !== "detach") requestPolicyAttestor?.();
          if (
            ["wait-result", "wait-admission", "wait-lease"].includes(
              message.action,
            )
          ) {
            const timeoutMs = message.params?.timeoutMs ?? 0;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
              throw new CoordinatorError(
                "INVALID_ARGUMENT",
                "timeoutMs must be non-negative",
              );
            }
            const waiter = {
              socket,
              id: message.id,
              action: message.action,
              params: message.params,
              timer: null,
            };
            if (timeoutMs) {
              waiter.timer = setTimeout(() => {
                try {
                  assertResponseAuthority(`${message.action}-timeout-response`);
                  waiters.delete(waiter);
                  failResponse(
                    socket,
                    message.id,
                    new CoordinatorError(
                      "WAIT_TIMEOUT",
                      `${message.action} timed out`,
                    ),
                  );
                } catch (error) {
                  waiters.delete(waiter);
                  respondWithError(socket, message.id, error);
                }
                scheduleIdle();
              }, timeoutMs);
            }
            waiters.add(waiter);
            evaluateWaiter(waiter);
            continue;
          }
          if (message.action === "detach") {
            bindings.get(connectionId)?.clear();
            sendResponse(socket, message.id, { detached: true });
            continue;
          }
          const response = dispatch(message.action, message.params);
          if (
            message.action === "register" &&
            message.params?.bindConnection === true
          ) {
            requestPolicyAttestor?.();
            bindings
              .get(connectionId)
              ?.set(
                message.params.requestId,
                JSON.parse(JSON.stringify(message.params.owner)),
              );
          }
          assertResponseAuthority(`${message.action}-response`);
          sendResponse(socket, message.id, response);
        } catch (error) {
          if (message?.action !== "detach") {
            try {
              assertResponseAuthority(
                `${message?.action ?? "invalid"}-error-response`,
              );
            } catch (attestationError) {
              if (
                respondWithError(
                  socket,
                  message?.id ?? "invalid",
                  attestationError,
                )
              ) {
                return;
              }
              continue;
            }
          }
          if (respondWithError(socket, message?.id ?? "invalid", error)) {
            return;
          }
        }
      }
    });
    socket.on("close", () => {
      connections.delete(socket);
      for (const waiter of [...waiters]) {
        if (waiter.socket === socket) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
        }
      }
      const bound = bindings.get(connectionId) ?? new Map();
      bindings.delete(connectionId);
      if (!isClosing()) {
        for (const [requestId, owner] of bound) {
          if (isClosing()) break;
          const maintained = runMaintenance("bound-client-cleanup", () =>
            core.markOwnerStale({
              requestId,
              observedOwner: owner,
              reporter: coordinatorIdentity,
              reason: "bound client disconnected",
              autoAcknowledge: true,
            }),
          );
          if (!maintained.ran) break;
        }
      }
      scheduleIdle();
    });
  };
}
