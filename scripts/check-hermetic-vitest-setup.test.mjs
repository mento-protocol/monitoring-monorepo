import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  configLoadsGuard,
  setupFilesLoadsGuard,
  stripTypeScriptComments,
} from "./check-hermetic-vitest-setup.mjs";

test("detects the hermetic setup path in setupFiles arrays", () => {
  assert.equal(
    setupFilesLoadsGuard(`
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [
      "./vitest.hermetic-setup.ts",
      "./test/setup.ts",
    ],
  },
});
`),
    true,
  );
});

test("detects the hermetic setup path in setupFiles string form", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    setupFiles: './vitest.hermetic-setup.ts',
  },
};
`),
    true,
  );
});

test("detects the hermetic setup path under quoted setupFiles keys", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    "setupFiles": ["./vitest.hermetic-setup.ts"],
  },
};
`),
    true,
  );
});

test("ignores line comments that mention setupFiles", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    // setupFiles: ["./vitest.hermetic-setup.ts"],
    environment: "node",
  },
};
`),
    false,
  );
});

test("ignores block comments that mention setupFiles", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    /*
     * setupFiles: ["./vitest.hermetic-setup.ts"],
     */
    environment: "node",
  },
};
`),
    false,
  );
});

test("requires the path to be in setupFiles", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    include: ["./vitest.hermetic-setup.ts"],
    setupFiles: ["./other-setup.ts"],
  },
};
`),
    false,
  );
});

test("ignores setupFiles text inside ordinary strings", () => {
  assert.equal(
    setupFilesLoadsGuard(`
const example = 'setupFiles: ["./vitest.hermetic-setup.ts"]';
export default {
  test: {
    environment: "node",
  },
};
`),
    false,
  );
});

test("does not accept partial setup path matches", () => {
  assert.equal(
    setupFilesLoadsGuard(`
export default {
  test: {
    setupFiles: ["prefix./vitest.hermetic-setup.ts"],
  },
};
`),
    false,
  );
});

test("comment stripping preserves string literals", () => {
  assert.match(
    stripTypeScriptComments(`
const url = "https://example.com/path";
const setup = "./vitest.hermetic-setup.ts"; // comment
`),
    /https:\/\/example\.com\/path/,
  );
});

test("configLoadsGuard reports a config with only commented setupFiles as missing", () => {
  const root = mkdtempSync(join(tmpdir(), "hermetic-vitest-test-"));
  const workspace = "workspace";
  mkdirSync(join(root, workspace), { recursive: true });
  writeFileSync(
    join(root, workspace, "vitest.config.ts"),
    `
export default {
  test: {
    // setupFiles: ["./vitest.hermetic-setup.ts"],
  },
};
`,
    "utf8",
  );

  const result = configLoadsGuard(root, workspace);
  rmSync(root, { recursive: true, force: true });

  assert.deepEqual(result, {
    relativePath: "workspace/vitest.config.ts",
    ok: false,
    reason: "missing setupFiles guard",
  });
});
