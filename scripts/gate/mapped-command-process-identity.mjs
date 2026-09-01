import { fstatSync } from "node:fs";

const GATE_MARKER_FDS = Object.freeze([6, 8, 9]);
const GATE_MARKER_FD_SET = new Set(GATE_MARKER_FDS);
const GATE_IDENTITY = /^agentqg:[A-Za-z0-9._:-]+$/u;

function carriesGateIdentity(environment) {
  return [environment.AGENTQG_RUN, environment.AGENTQG_REQUEST].some(
    (value) => typeof value === "string" && GATE_IDENTITY.test(value),
  );
}

function normalizedStdio(stdio) {
  if (stdio === undefined) return ["pipe", "pipe", "pipe"];
  if (typeof stdio === "string") return [stdio, stdio, stdio];
  if (Array.isArray(stdio)) return [...stdio];
  throw new TypeError("child stdio must be a string or an array");
}

function declaredMarkerDescriptors(environment) {
  const value = environment.AGENTQG_MARKER_FDS;
  if (typeof value !== "string" || !/^(?:6|8|9)(?:,(?:6|8|9))*$/u.test(value)) {
    throw new Error(
      "mapped command has no valid AGENTQG_MARKER_FDS declaration",
    );
  }
  const descriptors = value.split(",").map(Number);
  if (
    new Set(descriptors).size !== descriptors.length ||
    descriptors.some((fd) => !GATE_MARKER_FD_SET.has(fd))
  ) {
    throw new Error("mapped command marker descriptor declaration is invalid");
  }
  return descriptors;
}

/**
 * Keep the gate's command, request, and coordinator marker files open in a
 * detached child from its first instruction.
 *
 * The gate opens these regular files on descriptors 9, 8, and 6 and exports
 * the exact open set in AGENTQG_MARKER_FDS. Node closes descriptors above
 * stderr unless the spawn's stdio array names them. This helper requires every
 * surviving declared descriptor to remain an open regular file. Darwin binds
 * a mapped root to its exact kernel lineage before START, so a nested runtime
 * that closed every marker can discard a stale declaration. Other platforms
 * keep the marker-only fail-closed rule. A partially surviving declaration is
 * always invalid. This helper never passes fd 17, which is the parallel
 * worker's private launch and sentinel pipe.
 */
export function inheritGateMarkerStdio(
  stdio,
  {
    environment = process.env,
    descriptorStat = fstatSync,
    platform = process.platform,
  } = {},
) {
  if (!carriesGateIdentity(environment)) return stdio;

  const descriptorStates = declaredMarkerDescriptors(environment).map((fd) => {
    try {
      return { fd, regular: descriptorStat(fd)?.isFile?.() === true };
    } catch (error) {
      return { error, fd, regular: false };
    }
  });

  const unexpectedError = descriptorStates.find(
    ({ error }) => error && error.code !== "EBADF",
  );
  if (unexpectedError) {
    throw new Error(
      `mapped command marker descriptor ${unexpectedError.fd} could not be inspected`,
      { cause: unexpectedError.error },
    );
  }

  if (
    platform === "darwin" &&
    !descriptorStates.some(({ regular }) => regular)
  ) {
    return stdio;
  }

  for (const { error, fd, regular } of descriptorStates) {
    if (error) {
      throw new Error(`mapped command marker descriptor ${fd} is not open`, {
        cause: error,
      });
    }
    if (!regular) {
      throw new Error(
        `mapped command marker descriptor ${fd} is not a regular file`,
      );
    }
  }

  const result = normalizedStdio(stdio);
  for (const { fd } of descriptorStates) {
    while (result.length <= fd) result.push("ignore");
    result[fd] = fd;
  }
  return result;
}

export const gateMarkerDescriptorsForTest = GATE_MARKER_FDS;
