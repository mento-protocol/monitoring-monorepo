#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./schema-diff.mjs", import.meta.url));
const headSchemaPath = fileURLToPath(
  new URL("../indexer-envio/schema.graphql", import.meta.url),
);

test("schema diff rejects empty stdin before adding framework stubs", () => {
  for (const input of ["", " \n\t"]) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "-", headSchemaPath],
      {
        encoding: "utf8",
        input,
        timeout: 10_000,
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^Failed to read schema from stdin: schema input is empty\n$/u,
    );
  }
});
