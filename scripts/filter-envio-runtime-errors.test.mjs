import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  filterEnvioRuntimeErrors,
  isEnvioRuntimeError,
} from "./filter-envio-runtime-errors.mjs";

test("keeps only Envio records explicitly marked as errors", () => {
  const error = { level: "error", msg: "Indexer has failed, restarting" };
  const structuredError = {
    level: "stdout",
    error: { message: "database write failed" },
  };

  assert.equal(isEnvioRuntimeError(error), true);
  assert.equal(isEnvioRuntimeError(structuredError), true);
  assert.equal(
    isEnvioRuntimeError({ level: "stdout", msg: "WARN upstream failed" }),
    false,
  );
  assert.deepEqual(
    filterEnvioRuntimeErrors({
      ok: true,
      data: [error, structuredError, { level: "warn" }],
    }),
    { ok: true, data: [error, structuredError] },
  );
});

test("rejects a malformed Envio log payload", () => {
  assert.throws(
    () => filterEnvioRuntimeErrors({ ok: true, data: null }),
    /data array/,
  );
});

test("wrapper rejects streaming or build-log error filtering", () => {
  const wrapper = fileURLToPath(
    new URL("./deploy-indexer-logs.sh", import.meta.url),
  );
  for (const incompatible of ["--follow", "--build"]) {
    const result = spawnSync(
      "bash",
      [wrapper, "b5d14b7", "--errors-only", incompatible],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2, incompatible);
    assert.match(result.stdout, /--errors-only/);
  }
});
