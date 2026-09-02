import assert from "node:assert/strict";
import {
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeReopenedGateMarkers,
  gateMarkerDescriptorsForTest,
  inheritGateMarkerStdio,
} from "./mapped-command-process-identity.mjs";

const regularFile = { isFile: () => true };
const reusedDescriptor = { isFile: () => false };

function closedDescriptor() {
  throw Object.assign(new Error("closed"), { code: "EBADF" });
}

const markerRoot = mkdtempSync(join(tmpdir(), "agentqg-marker-"));
let markerSequence = 0;

/** A real marker file, so a reopen authenticates against a real inode. */
function markerFile(name = `marker-${(markerSequence += 1)}`) {
  const path = join(markerRoot, name);
  writeFileSync(path, "agentqg:test-run\n");
  return path;
}

/**
 * Stubs that open real files and hand back real descriptors.
 *
 * Fabricated descriptor numbers would be registered in the module's reopened
 * set and then closed by closeReopenedGateMarkers(), which is the test runner's
 * own fd 8 or 41 on a busy host. Every number released here is one this suite
 * opened. Only the declared inherited descriptors are faked, because a
 * descriptor the gate opened before a runtime clobbered it is the one thing a
 * test cannot produce in-process; a descriptor this opener returned is stat'd
 * for real, which is what the reopen's authentication reads.
 */
function markerStubs(inheritedStat, events = []) {
  const opened = new Set();
  const fds = [];
  const paths = [];
  return {
    events,
    fds,
    paths,
    descriptorStat: (fd) => {
      if (opened.has(fd)) return fstatSync(fd);
      events.push(`stat:${fd}`);
      return inheritedStat(fd);
    },
    openMarker: (path, flags) => {
      events.push(`open:${path}`);
      paths.push(path);
      const fd = openSync(path, flags);
      opened.add(fd);
      fds.push(fd);
      return fd;
    },
  };
}

test("marker stdio is unchanged outside a mapped command", () => {
  const stdio = ["ignore", "pipe", "pipe"];
  let inspected = false;
  assert.equal(
    inheritGateMarkerStdio(stdio, {
      environment: {},
      descriptorStat: () => {
        inspected = true;
        return regularFile;
      },
    }),
    stdio,
  );
  assert.equal(inspected, false);
});

test("an unrelated descriptor 9 alone is not treated as a marker", () => {
  const stdio = ["ignore", "pipe", "pipe"];
  assert.equal(
    inheritGateMarkerStdio(stdio, {
      environment: { AGENTQG_MARKER_FDS: "9" },
      descriptorStat: () => regularFile,
    }),
    stdio,
  );
});

test("a detached child inherits the exact declared gate marker files", () => {
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,6",
    },
    descriptorStat: () => regularFile,
    platform: "darwin",
  });

  assert.deepEqual(gateMarkerDescriptorsForTest, [6, 8, 9]);
  assert.equal(inherited[6], 6);
  assert.equal(inherited[8], "ignore");
  assert.equal(inherited[9], 9);
  assert.equal(inherited[17], undefined);
});

test("Darwin discards an all-stale marker declaration", () => {
  const stdio = ["ignore", "pipe", "pipe"];
  const inspected = [];

  assert.equal(
    inheritGateMarkerStdio(stdio, {
      environment: {
        AGENTQG_REQUEST: "agentqg:test-request",
        AGENTQG_MARKER_FDS: "9,8",
      },
      descriptorStat: (fd) => {
        inspected.push(fd);
        if (fd === 8) {
          throw Object.assign(new Error("closed"), { code: "EBADF" });
        }
        return { isFile: () => false };
      },
      platform: "darwin",
    }),
    stdio,
  );
  assert.deepEqual(inspected, [9, 8]);
});

test("Linux rejects an all-stale marker declaration", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_REQUEST: "agentqg:test-request",
          AGENTQG_MARKER_FDS: "8",
        },
        descriptorStat: () => ({ isFile: () => false }),
        platform: "linux",
      }),
    /descriptor 8 is not a regular file/,
  );
});

test("Darwin rejects an unexpected marker inspection error", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_REQUEST: "agentqg:test-request",
          AGENTQG_MARKER_FDS: "8",
        },
        descriptorStat: () => {
          throw Object.assign(new Error("input/output error"), { code: "EIO" });
        },
        platform: "darwin",
      }),
    /descriptor 8 could not be inspected/,
  );
});

test("Darwin rejects a regular marker mixed with a reused descriptor", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_REQUEST: "agentqg:test-request",
          AGENTQG_MARKER_FDS: "8,9",
        },
        descriptorStat: (fd) =>
          fd === 8 ? regularFile : { isFile: () => false },
        platform: "darwin",
      }),
    /descriptor 9 is not a regular file/,
  );
});

test("Darwin rejects a regular marker mixed with a closed descriptor", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_REQUEST: "agentqg:test-request",
          AGENTQG_MARKER_FDS: "8,9",
        },
        descriptorStat: (fd) => {
          if (fd === 8) return regularFile;
          throw Object.assign(new Error("closed"), { code: "EBADF" });
        },
        platform: "darwin",
      }),
    /descriptor 9 is not open/,
  );
});

test("a tagged child refuses a missing or closed marker declaration", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: { AGENTQG_RUN: "agentqg:test-run" },
      }),
    /no valid AGENTQG_MARKER_FDS declaration/,
  );
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "8",
        },
        descriptorStat: () => {
          throw Object.assign(new Error("closed"), { code: "EBADF" });
        },
        platform: "linux",
      }),
    /descriptor 8 is not open/,
  );
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "8,8",
        },
        descriptorStat: () => regularFile,
      }),
    /declaration is invalid/,
  );
});

// Issue 2189. pnpm takes descriptors 6, 8, and 9 for its own pipes and an
// eventfd before a mapped command's child runs, so on Linux every declared
// marker read as a reused descriptor and the command refused to start. The
// declared path is what survives that.

test("a reused descriptor is reopened from its declared marker path", () => {
  const command = markerFile("command");
  const coordinator = markerFile("coordinator");
  const stubs = markerStubs(() => reusedDescriptor);
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,6",
      AGENTQG_MARKER_PATH_9: command,
      AGENTQG_MARKER_PATH_6: coordinator,
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.deepEqual(stubs.paths, [command, coordinator]);
  assert.equal(inherited[9], stubs.fds[0]);
  assert.equal(inherited[6], stubs.fds[1]);
  assert.equal(inherited[8], "ignore");
  assert.equal(inherited[17], undefined);
  closeReopenedGateMarkers();
});

test("a closed descriptor is reopened from its declared marker path", () => {
  const request = markerFile();
  const stubs = markerStubs(closedDescriptor);
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "8",
      AGENTQG_MARKER_PATH_8: request,
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.equal(inherited[8], stubs.fds[0]);
  closeReopenedGateMarkers();
});

test("an inherited marker is kept rather than reopened", () => {
  const stubs = markerStubs(() => regularFile);
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: markerFile(),
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.equal(inherited[9], 9);
  assert.deepEqual(stubs.paths, []);
});

test("a marker path that cannot be opened still fails closed on Linux", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: join(markerRoot, "never-created"),
        },
        descriptorStat: () => reusedDescriptor,
        platform: "linux",
      }),
    /descriptor 9 is not a regular file/,
  );
});

test("a partially reopened declaration is still invalid", () => {
  const stubs = markerStubs(() => reusedDescriptor);
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9,8",
          AGENTQG_MARKER_PATH_9: markerFile(),
        },
        descriptorStat: stubs.descriptorStat,
        openMarker: stubs.openMarker,
        platform: "linux",
      }),
    /descriptor 8 is not a regular file/,
  );
  closeReopenedGateMarkers();
});

test("Darwin keeps a declaration that resolves only by reopening", () => {
  const stubs = markerStubs(() => reusedDescriptor);
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_REQUEST: "agentqg:test-request",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: markerFile(),
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "darwin",
  });

  assert.equal(inherited[9], stubs.fds[0]);
  closeReopenedGateMarkers();
});

test("an unexpected inspection error is answered by a successful reopen", () => {
  const stubs = markerStubs(() => {
    throw Object.assign(new Error("input/output error"), { code: "EIO" });
  });
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: markerFile(),
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.equal(inherited[9], stubs.fds[0]);
  closeReopenedGateMarkers();
});

test("an unexpected inspection error with no usable path still throws", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: join(markerRoot, "never-created"),
        },
        descriptorStat: () => {
          throw Object.assign(new Error("input/output error"), { code: "EIO" });
        },
        platform: "linux",
      }),
    /descriptor 9 could not be inspected/,
  );
});

test("a marker path keeps colons, and an undeclared descriptor is ignored", () => {
  const command = markerFile("mark:ers-command");
  const stubs = markerStubs(() => reusedDescriptor);
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: command,
      AGENTQG_MARKER_PATH_8: markerFile(),
      AGENTQG_MARKER_PATH_7: markerFile(),
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.deepEqual(stubs.paths, [command]);
  assert.equal(inherited[9], stubs.fds[0]);
  assert.equal(inherited[8], "ignore");
  closeReopenedGateMarkers();
});

// Opening a declared name proves only that something readable answers to it.
// These pin what the reopen additionally demands before a descriptor becomes a
// marker the child inherits, and that a descriptor failing any of it is closed
// here rather than passed on.

test("a reopen refuses an object that is not a regular file", () => {
  const directory = join(markerRoot, "declared-directory");
  mkdirSync(directory, { recursive: true });
  const stubs = markerStubs(() => reusedDescriptor);

  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: directory,
        },
        descriptorStat: stubs.descriptorStat,
        openMarker: stubs.openMarker,
        platform: "linux",
      }),
    /descriptor 9 is not a regular file/,
  );
  // A directory opens cleanly on Linux, so the refusal has to release it.
  assert.equal(stubs.fds.length, 1);
  assert.throws(() => fstatSync(stubs.fds[0]), { code: "EBADF" });
});

test("a reopen refuses a symlink planted at the declared name", () => {
  // The link points at a genuine marker, so the only thing standing between
  // the child and a redirected name is the refusal itself. Two independent
  // checks reject it — O_NOFOLLOW on the open, and the declared name lstat'ing
  // to a link rather than a regular file — so this stays a refusal if either
  // is ever dropped.
  const link = join(markerRoot, "declared-symlink");
  symlinkSync(markerFile(), link);
  const stubs = markerStubs(() => reusedDescriptor);

  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: link,
        },
        descriptorStat: stubs.descriptorStat,
        openMarker: stubs.openMarker,
        platform: "linux",
      }),
    /descriptor 9 is not a regular file/,
  );
  for (const fd of stubs.fds) {
    assert.throws(() => fstatSync(fd), { code: "EBADF" });
  }
});

test("a reopen refuses a name that no longer resolves to what it opened", () => {
  const stubs = markerStubs(() => reusedDescriptor);

  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: markerFile(),
        },
        descriptorStat: stubs.descriptorStat,
        openMarker: stubs.openMarker,
        // The name was swapped between the open and the check, so the
        // descriptor holds a file the declared marker no longer names.
        pathStat: () => ({ dev: 1, ino: 2, isFile: () => true, uid: 0 }),
        platform: "linux",
      }),
    /descriptor 9 is not a regular file/,
  );
  assert.equal(stubs.fds.length, 1);
  assert.throws(() => fstatSync(stubs.fds[0]), { code: "EBADF" });
});

test("a reopen opens without following links and without blocking", () => {
  const flags = [];
  inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: markerFile(),
    },
    descriptorStat: (fd) => (fd === 9 ? reusedDescriptor : fstatSync(fd)),
    openMarker: (path, mode) => {
      flags.push(mode);
      return openSync(path, mode);
    },
    platform: "linux",
  });

  assert.equal(flags.length, 1);
  // O_NONBLOCK is what keeps a FIFO left at the declared name from parking the
  // whole command on an open that waits for a writer that never arrives.
  assert.equal(flags[0] & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  assert.equal(flags[0] & constants.O_NONBLOCK, constants.O_NONBLOCK);
  closeReopenedGateMarkers();
});

test("closeReopenedGateMarkers releases only the parent's reopened copies", () => {
  // Descriptor 8 is still the gate's own marker; only 9 was reused.
  const stubs = markerStubs((fd) =>
    fd === 8 ? regularFile : reusedDescriptor,
  );
  const reopened = stubs.fds;

  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,8",
      AGENTQG_MARKER_PATH_9: markerFile(),
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  assert.equal(reopened.length, 1);
  assert.equal(inherited[9], reopened[0]);
  assert.equal(inherited[8], 8);
  assert.equal(fstatSync(reopened[0]).isFile(), true);

  closeReopenedGateMarkers();

  assert.throws(() => fstatSync(reopened[0]), { code: "EBADF" });
  // Descriptor 8 was never ours to close, and a second call is a no-op rather
  // than a double close of a number the runtime may have since reused.
  assert.equal(fstatSync(8).isFile !== undefined, true);
  closeReopenedGateMarkers();
});

test("every declared descriptor is inspected before any path is reopened", () => {
  // Reopening allocates the lowest free descriptor, which can be one a later
  // declaration still names. Inspecting 8 only after opening 9 into it would
  // read marker 9's file through descriptor 8 and call it a survivor: both
  // child slots would carry marker 9 and marker 8 would never open, silently
  // dropping it from the containment evidence.
  const command = markerFile("ordering-command");
  const request = markerFile("ordering-request");
  const events = [];
  // Descriptor 8 is closed, and stands in for one a reopen has landed on once
  // any open has happened: under the one-pass order it would then read as a
  // survivor, and marker 8 would never open.
  const stubs = markerStubs(
    (fd) =>
      fd === 8 && stubs.paths.length === 0
        ? closedDescriptor()
        : fd === 8
          ? regularFile
          : reusedDescriptor,
    events,
  );
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,8",
      AGENTQG_MARKER_PATH_9: command,
      AGENTQG_MARKER_PATH_8: request,
    },
    descriptorStat: stubs.descriptorStat,
    openMarker: stubs.openMarker,
    platform: "linux",
  });

  // Both stats land before either open, so no open can change an inspection.
  assert.deepEqual(events, [
    "stat:9",
    "stat:8",
    `open:${command}`,
    `open:${request}`,
  ]);
  assert.equal(inherited[9], stubs.fds[0]);
  assert.equal(inherited[8], stubs.fds[1]);
  closeReopenedGateMarkers();
});
