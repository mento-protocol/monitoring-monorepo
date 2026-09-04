import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMMAND_PREFIX = "depcruise --config .dependency-cruiser.cjs ";

test("the dependency-cruiser command and config scan the same roots", () => {
  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const command = manifest.scripts?.["code-health:deps"];
  assert.equal(typeof command, "string", "code-health:deps must exist");
  assert.ok(
    command.startsWith(COMMAND_PREFIX),
    `code-health:deps must start with ${COMMAND_PREFIX}`,
  );
  const commandRoots = command.slice(COMMAND_PREFIX.length).split(/\s+/u);

  const require = createRequire(import.meta.url);
  const config = require(join(REPOSITORY_ROOT, ".dependency-cruiser.cjs"));
  const includeOnly = config.options?.includeOnly?.path;
  assert.equal(typeof includeOnly, "string");
  const match = /^\^\(([^)]+)\)\/$/u.exec(includeOnly);
  assert.ok(
    match,
    `includeOnly.path must be a root alternation: ${String(includeOnly)}`,
  );
  const configRoots = match[1].split("|");

  const sorted = (values) => [...values].sort();
  assert.deepEqual(
    sorted(commandRoots),
    sorted(configRoots),
    "code-health:deps and includeOnly.path must name the same roots",
  );
});
