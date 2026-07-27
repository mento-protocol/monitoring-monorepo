import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ENVIO_RUNTIME_LOG_PAGE_LIMIT,
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

test("fails closed when Envio fills the maximum runtime-log page", () => {
  const belowLimit = Array.from(
    { length: ENVIO_RUNTIME_LOG_PAGE_LIMIT - 1 },
    (_, index) => ({ level: "stdout", msg: `record ${index}` }),
  );
  assert.equal(filterEnvioRuntimeErrors({ data: belowLimit }).data.length, 0);

  const fullPage = [
    ...belowLimit,
    { level: "stdout", msg: "record at the provider cap" },
  ];
  assert.throws(
    () => filterEnvioRuntimeErrors({ data: fullPage }),
    /full 100-record page.*may contain unreturned errors/,
  );

  const filter = fileURLToPath(
    import.meta.resolve("./filter-envio-runtime-errors.mjs"),
  );
  const result = spawnSync(process.execPath, [filter], {
    encoding: "utf8",
    input: JSON.stringify({ data: fullPage }),
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Narrow --since and retry/);
});

test("wrapper rejects flags that conflict with exact error filtering", () => {
  const wrapper = fileURLToPath(
    new URL("./deploy-indexer-logs.sh", import.meta.url),
  );
  const incompatibleCases = [
    ["--follow"],
    ["--follow=true"],
    ["--follow=True"],
    ["--follow=TRUE"],
    ["--follow=1"],
    ["--follow=t"],
    ["--follow=T"],
    ["--build"],
    ["--build=true"],
    ["--build=True"],
    ["--build=TRUE"],
    ["--build=1"],
    ["--build=t"],
    ["--build=T"],
    ["--level", "error,warn"],
    ["--level=warn"],
    ["-o", "table"],
    ["--output", "table"],
    ["--output=table"],
    ["--limit", "1"],
    ["--limit", "99"],
    ["--limit", "100"],
    ["--limit"],
    ["--limit=1"],
    ["--limit=99"],
    ["--limit=100"],
    ["--limit="],
    ["--limit=0"],
    ["--limit=-1"],
  ];
  for (const incompatible of incompatibleCases) {
    const result = spawnSync(
      "bash",
      [wrapper, "b5d14b7", "--errors-only", ...incompatible],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2, incompatible.join(" "));
    assert.match(result.stdout, /--errors-only/);
  }
});

test("wrapper fixes the provider page size and propagates capped-page failure", () => {
  const wrapper = fileURLToPath(
    new URL("./deploy-indexer-logs.sh", import.meta.url),
  );
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const tempDirectory = mkdtempSync(join(tmpdir(), "envio-log-filter-"));
  const fakePnpm = join(tempDirectory, "pnpm");
  const capturedArgs = join(tempDirectory, "deployment-log-args");

  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "exec envio-cloud indexer get mento mento-protocol -o json" ]]; then
  printf '%s' '{"data":{"deployments":[{"commit_hash":"b5d14b7","created_time":"2026-07-26T00:00:00Z"}]}}'
elif [[ "$1 $2 $3 $4" == "exec envio-cloud deployment logs" ]]; then
  printf '%s\\n' "$@" > "$ENVIO_LOG_ARGS_FILE"
  printf '%s' "$ENVIO_LOG_RESPONSE"
else
  printf 'unexpected fake pnpm invocation: %s\\n' "$*" >&2
  exit 97
fi
`,
  );
  chmodSync(fakePnpm, 0o755);

  const runWrapper = (recordCount) =>
    spawnSync("bash", [wrapper, "b5d14b7", "--errors-only", "--since", "2h"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ENVIO_LOG_ARGS_FILE: capturedArgs,
        ENVIO_LOG_RESPONSE: JSON.stringify({
          data: Array.from({ length: recordCount }, (_, index) => ({
            level: "stdout",
            msg: `record ${index}`,
          })),
        }),
        PATH: `${tempDirectory}:${process.env.PATH}`,
      },
    });

  try {
    const completePage = runWrapper(ENVIO_RUNTIME_LOG_PAGE_LIMIT - 1);
    assert.equal(completePage.status, 0);
    assert.equal(completePage.stderr, "");
    assert.deepEqual(JSON.parse(completePage.stdout), { data: [] });
    assert.deepEqual(readFileSync(capturedArgs, "utf8").trim().split("\n"), [
      "exec",
      "envio-cloud",
      "deployment",
      "logs",
      "mento",
      "b5d14b7",
      "mento-protocol",
      "--since",
      "2h",
      "--level",
      "error",
      "--limit",
      "100",
      "-o",
      "json",
    ]);

    const cappedPage = runWrapper(ENVIO_RUNTIME_LOG_PAGE_LIMIT);
    assert.equal(cappedPage.status, 2);
    assert.equal(cappedPage.stdout, "");
    assert.match(cappedPage.stderr, /full 100-record page/);
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});
