// Required CI runs this test via scripts/lighthouse-config.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dashboardRequire = createRequire(
  path.resolve("ui-dashboard/package.json"),
);
const pluginRequire = createRequire(
  dashboardRequire.resolve("@next/eslint-plugin-next"),
);
const { getRootDirs } = pluginRequire("./utils/get-root-dirs.js");

test("Next root-directory globs do not expand literal roots into descendants", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "next-root-globs-"));
  try {
    for (const dir of ["web/src/nested", "web/node_modules/pkg", "admin/src"]) {
      mkdirSync(path.join(fixture, dir), { recursive: true });
    }
    const roots = (rootDir) =>
      getRootDirs({ cwd: fixture, settings: { next: { rootDir } } })
        .map((dir) => path.resolve(dir))
        .sort();
    const web = path.join(fixture, "web");
    const admin = path.join(fixture, "admin");
    assert.deepEqual(roots(web), [web]);
    assert.deepEqual(roots(path.join(fixture, "{web,admin}")), [admin, web]);
    assert.deepEqual(roots([web, admin]), [admin, web]);
    assert.deepEqual(roots(path.join(fixture, "missing")), []);
    assert.deepEqual(getRootDirs({ cwd: fixture, settings: {} }), [fixture]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
