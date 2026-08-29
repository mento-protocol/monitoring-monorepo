import assert from "node:assert/strict";
import test from "node:test";

import {
  gateMarkerDescriptorsForTest,
  inheritGateMarkerStdio,
} from "./mapped-command-process-identity.mjs";

const regularFile = { isFile: () => true };

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
