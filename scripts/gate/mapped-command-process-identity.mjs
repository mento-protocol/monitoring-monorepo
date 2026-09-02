import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

// The same flags the gate itself opens a marker with (gate_run_marker_verify in
// scripts/gate/run-handles.sh). O_NOFOLLOW refuses a symlink planted at the
// declared name, and O_NONBLOCK keeps a FIFO left there from parking this
// process forever waiting for a writer that never comes.
const MARKER_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const GATE_MARKER_FDS = Object.freeze([6, 8, 9]);
const GATE_MARKER_FD_SET = new Set(GATE_MARKER_FDS);
const GATE_IDENTITY = /^agentqg:[A-Za-z0-9._:-]+$/u;

// Descriptors this module opened itself, so a caller that spawns repeatedly can
// hand them back with closeReopenedGateMarkers(). Reopened markers are the
// parent's copies; the child keeps its own after spawn.
const reopenedMarkerDescriptors = new Set();

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
 * Where the gate says a declared marker lives.
 *
 * One variable per descriptor, AGENTQG_MARKER_PATH_<fd>, because a marker path
 * may contain any byte a packed separator could use — including the newline an
 * earlier form of this used, which did not survive the environment intact.
 * AGENTQG_MARKER_FDS stays the authority for which markers exist; a path only
 * says where to find one, so a missing variable is not an error here.
 */
function declaredMarkerPath(environment, fd) {
  const value = environment[`AGENTQG_MARKER_PATH_${fd}`];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Reopen a declared marker path, or refuse it.
 *
 * Opening a path proves nothing on its own: a readable object at the declared
 * name may be a directory, a device, a FIFO, or a regular file that is no
 * longer the marker. Any of those would let the child inherit a stranger while
 * this helper reported full containment, so the descriptor is authenticated
 * before it becomes a source, on the same terms the gate uses when it opens a
 * marker itself: a regular file, owned by this user, and the same inode the
 * declared name still resolves to. That last comparison is what closes the
 * window between the open and the check — a name swapped underneath us fails
 * it. A descriptor that does not earn its place is closed here, not passed on.
 */
function reopenDeclaredMarker(path, openMarker, descriptorStat, pathStat) {
  let reopened;
  try {
    reopened = openMarker(path, MARKER_OPEN_FLAGS);
    const opened = descriptorStat(reopened);
    const named = pathStat(path);
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      opened?.isFile?.() === true &&
      named?.isFile?.() === true &&
      opened.dev === named.dev &&
      opened.ino === named.ino &&
      (uid === undefined || opened.uid === uid)
    ) {
      return reopened;
    }
  } catch {
    // An unopenable or unstattable path is a marker that did not resolve.
  }
  if (reopened !== undefined) {
    try {
      closeSync(reopened);
    } catch {
      // Nothing to release.
    }
  }
  return undefined;
}

/**
 * Keep the gate's command, request, and coordinator marker files open in a
 * detached child from its first instruction.
 *
 * The gate opens these regular files on descriptors 9, 8, and 6 and exports
 * the exact open set in AGENTQG_MARKER_FDS, plus where to find each in
 * AGENTQG_MARKER_PATH_<fd>. Node closes descriptors above stderr unless the
 * spawn's stdio array names them. This helper requires every surviving
 * declared descriptor to resolve to the marker.
 *
 * A descriptor resolves one of two ways. It is still an open regular file, so
 * it is passed through; or it is not, and the declared path is reopened. The
 * second case exists because a runtime between the gate and a mapped command
 * reuses low descriptors for its own handles: pnpm takes 6, 8, and 9 for pipes
 * and an eventfd, which left every mapped pnpm command on Linux refusing to
 * start (issue 2189).
 *
 * The two are not equal evidence, and the weaker one is the new one. An
 * inherited descriptor is the marker — the gate opened that exact inode before
 * any runtime ran, so nothing since can have substituted it. A reopen only
 * proves that the declared name resolves, right now, to a regular file owned
 * by this user; between the gate's open and this one, something with write
 * access to the marker's directory could have replaced the file the name
 * points at. Authentication narrows that gap but does not close it, so an
 * inherited descriptor is always preferred and a reopen is never used to
 * replace one.
 *
 * Darwin binds a mapped root to its exact kernel lineage before START, so a
 * nested runtime that closed every marker can discard a declaration that
 * resolves nowhere. Other platforms keep the marker-only fail-closed rule: the
 * markers are the only evidence a later gate has for recovering a detached
 * descendant, so a Linux command that cannot produce one must not start. A
 * partially resolving declaration is always invalid. This helper never passes
 * fd 17, which is the parallel worker's private launch and sentinel pipe.
 */
export function inheritGateMarkerStdio(
  stdio,
  {
    environment = process.env,
    descriptorStat = fstatSync,
    openMarker = openSync,
    pathStat = lstatSync,
    platform = process.platform,
  } = {},
) {
  if (!carriesGateIdentity(environment)) return stdio;

  // Inspect every declared descriptor BEFORE reopening any path. Opening
  // allocates the lowest free descriptor, which can be one a later declaration
  // still names: for a `9,8` declaration with 8 closed, reopening marker 9
  // lands on 8, and inspecting 8 afterwards would read marker 9's file and
  // call it a survivor. Both child slots would then carry marker 9 and marker
  // 8 would never open, silently dropping it from the containment evidence.
  const inspections = declaredMarkerDescriptors(environment).map((fd) => {
    try {
      return { fd, regular: descriptorStat(fd)?.isFile?.() === true };
    } catch (error) {
      return { error, fd, regular: false };
    }
  });

  const descriptorStates = inspections.map((inspection) => {
    const { fd } = inspection;
    // An inherited descriptor that is still the marker costs nothing to keep.
    if (inspection.regular) return { ...inspection, source: fd };
    const path = declaredMarkerPath(environment, fd);
    if (path === undefined) return inspection;
    const reopened = reopenDeclaredMarker(
      path,
      openMarker,
      descriptorStat,
      pathStat,
    );
    if (reopened === undefined) return inspection;
    reopenedMarkerDescriptors.add(reopened);
    // An authenticated reopen answers the inspection, including an EBADF that
    // only means the runtime closed the inherited copy.
    return { fd, regular: true, source: reopened };
  });

  const unexpectedError = descriptorStates.find(
    ({ error, source }) =>
      source === undefined && error && error.code !== "EBADF",
  );
  if (unexpectedError) {
    throw new Error(
      `mapped command marker descriptor ${unexpectedError.fd} could not be inspected`,
      { cause: unexpectedError.error },
    );
  }

  if (
    platform === "darwin" &&
    !descriptorStates.some(({ source }) => source !== undefined)
  ) {
    return stdio;
  }

  for (const { error, fd, source } of descriptorStates) {
    if (source !== undefined) continue;
    if (error) {
      throw new Error(`mapped command marker descriptor ${fd} is not open`, {
        cause: error,
      });
    }
    throw new Error(
      `mapped command marker descriptor ${fd} is not a regular file`,
    );
  }

  const result = normalizedStdio(stdio);
  for (const { fd, source } of descriptorStates) {
    while (result.length <= fd) result.push("ignore");
    result[fd] = source;
  }
  return result;
}

/**
 * Release the parent's copies of any markers this module reopened.
 *
 * Call it after the spawn that consumed the stdio array. The child keeps its
 * own descriptors, so closing here costs the caller nothing and keeps a
 * process that spawns repeatedly from accruing one descriptor per marker per
 * spawn. Closing is best effort: a descriptor the caller already closed is not
 * an error worth propagating.
 */
export function closeReopenedGateMarkers() {
  for (const fd of reopenedMarkerDescriptors) {
    try {
      closeSync(fd);
    } catch {
      // Already closed, or never ours to close.
    }
  }
  reopenedMarkerDescriptors.clear();
}

export const gateMarkerDescriptorsForTest = GATE_MARKER_FDS;
