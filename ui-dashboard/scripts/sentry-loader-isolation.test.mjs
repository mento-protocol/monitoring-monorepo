import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

// Regression for getsentry/sentry-javascript#24650/#24651. Exercise installed
// loaders, not patch text: CLI imports must fail while injection and the v11.0.0
// Babel annotation path still work. A fresh process isolates the require guard.
test("Sentry 11 loaders preserve transforms without importing the CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      String.raw`
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { createRequire } = Module;
const appRequire = createRequire(path.resolve("ui-dashboard/package.json"));
const nextRoot = path.dirname(appRequire.resolve("@sentry/nextjs/package.json"));
const packageRequire = createRequire(path.join(nextRoot, "package.json"));
const originalLoad = Module._load;
Module._load = function (specifier, ...args) {
  if (specifier === "sentry") throw new Error("loader imported the Sentry CLI");
  return originalLoad.call(this, specifier, ...args);
};
(async () => {
  const loaders = ["valueInjectionLoader", "moduleMetadataInjectionLoader", "componentAnnotationLoader"];
  for (const name of loaders) {
    const loader = require(path.join(nextRoot, "build/cjs/config/loaders", name + ".js"));
    assert.equal(typeof loader.default, "function");
  }
  const injection = require(path.join(nextRoot, "build/cjs/config/loaders/valueInjectionLoader.js")).default;
  const output = injection.call({ getOptions: () => ({ values: { sentinel: "preserved" } }), cacheable() {} }, '"use strict";\nconsole.log("app");');
  assert.match(output, /globalThis\["sentinel"\] = "preserved"/);
  assert.ok(output.startsWith('"use strict";'));
  assert.ok(output.indexOf('globalThis["sentinel"]') < output.indexOf('console.log'));
  const helpers = packageRequire("@sentry/bundler-plugins/loader-utils");
  const hooks = helpers.createComponentNameAnnotateHooks([], false);
  const annotated = await hooks.transform("export function Example() { return <div>Hello</div>; }", "example.jsx");
  assert.match(annotated.code, /data-sentry-component="Example"/);
  assert.match(annotated.code, /data-sentry-source-file="example.jsx"/);
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
