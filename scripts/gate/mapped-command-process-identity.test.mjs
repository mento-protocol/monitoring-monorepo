import assert from "node:assert/strict";
import { fstatSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
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
  const opened = [];
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,6",
      AGENTQG_MARKER_PATH_9: "/run/markers/command",
      AGENTQG_MARKER_PATH_6: "/run/markers/coordinator",
    },
    descriptorStat: () => reusedDescriptor,
    openMarker: (path) => {
      opened.push(path);
      return 40 + opened.length;
    },
    platform: "linux",
  });

  assert.deepEqual(opened, [
    "/run/markers/command",
    "/run/markers/coordinator",
  ]);
  assert.equal(inherited[9], 41);
  assert.equal(inherited[6], 42);
  assert.equal(inherited[8], "ignore");
  assert.equal(inherited[17], undefined);
  closeReopenedGateMarkers();
});

test("a closed descriptor is reopened from its declared marker path", () => {
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "8",
      AGENTQG_MARKER_PATH_8: "/run/markers/request",
    },
    descriptorStat: closedDescriptor,
    openMarker: () => 51,
    platform: "linux",
  });

  assert.equal(inherited[8], 51);
  closeReopenedGateMarkers();
});

test("an inherited marker is kept rather than reopened", () => {
  let opened = false;
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: "/run/markers/command",
    },
    descriptorStat: () => regularFile,
    openMarker: () => {
      opened = true;
      return 60;
    },
    platform: "linux",
  });

  assert.equal(inherited[9], 9);
  assert.equal(opened, false);
});

test("a marker path that cannot be opened still fails closed on Linux", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: "/run/markers/command",
        },
        descriptorStat: () => reusedDescriptor,
        openMarker: () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        platform: "linux",
      }),
    /descriptor 9 is not a regular file/,
  );
});

test("a partially reopened declaration is still invalid", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9,8",
          AGENTQG_MARKER_PATH_9: "/run/markers/command",
        },
        descriptorStat: () => reusedDescriptor,
        openMarker: () => 70,
        platform: "linux",
      }),
    /descriptor 8 is not a regular file/,
  );
  closeReopenedGateMarkers();
});

test("Darwin keeps a declaration that resolves only by reopening", () => {
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_REQUEST: "agentqg:test-request",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: "/run/markers/command",
    },
    descriptorStat: () => reusedDescriptor,
    openMarker: () => 80,
    platform: "darwin",
  });

  assert.equal(inherited[9], 80);
  closeReopenedGateMarkers();
});

test("an unexpected inspection error is answered by a successful reopen", () => {
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: "/run/markers/command",
    },
    descriptorStat: () => {
      throw Object.assign(new Error("input/output error"), { code: "EIO" });
    },
    openMarker: () => 90,
    platform: "linux",
  });

  assert.equal(inherited[9], 90);
  closeReopenedGateMarkers();
});

test("an unexpected inspection error with no usable path still throws", () => {
  assert.throws(
    () =>
      inheritGateMarkerStdio("ignore", {
        environment: {
          AGENTQG_RUN: "agentqg:test-run",
          AGENTQG_MARKER_FDS: "9",
          AGENTQG_MARKER_PATH_9: "/run/markers/command",
        },
        descriptorStat: () => {
          throw Object.assign(new Error("input/output error"), { code: "EIO" });
        },
        openMarker: () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        platform: "linux",
      }),
    /descriptor 9 could not be inspected/,
  );
});

test("a marker path keeps colons, and an undeclared descriptor is ignored", () => {
  const opened = [];
  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9",
      AGENTQG_MARKER_PATH_9: "/run/mark:ers/command",
      AGENTQG_MARKER_PATH_8: "/run/markers/request",
      AGENTQG_MARKER_PATH_7: "/run/markers/bogus",
    },
    descriptorStat: () => reusedDescriptor,
    openMarker: (path) => {
      opened.push(path);
      return 100;
    },
    platform: "linux",
  });

  assert.deepEqual(opened, ["/run/mark:ers/command"]);
  assert.equal(inherited[9], 100);
  assert.equal(inherited[8], "ignore");
  closeReopenedGateMarkers();
});

test("closeReopenedGateMarkers releases only the parent's reopened copies", () => {
  const marker = join(
    mkdtempSync(join(tmpdir(), "agentqg-marker-")),
    "command",
  );
  writeFileSync(marker, "marker\n");
  const reopened = [];

  const inherited = inheritGateMarkerStdio(["ignore", "pipe", "pipe"], {
    environment: {
      AGENTQG_RUN: "agentqg:test-run",
      AGENTQG_MARKER_FDS: "9,8",
      AGENTQG_MARKER_PATH_9: marker,
    },
    // Descriptor 8 is still the gate's own marker; only 9 was reused.
    descriptorStat: (fd) => (fd === 8 ? regularFile : reusedDescriptor),
    openMarker: (path, flags) => {
      const fd = openSync(path, flags);
      reopened.push(fd);
      return fd;
    },
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
