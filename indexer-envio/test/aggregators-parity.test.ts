import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("aggregators.json", () => {
  it("keeps the vendored indexer copy in sync with shared-config", () => {
    const vendoredPath = join(
      import.meta.dirname,
      "..",
      "config",
      "aggregators.json",
    );
    const sharedPath = join(
      import.meta.dirname,
      "..",
      "..",
      "shared-config",
      "aggregators.json",
    );

    const vendored = JSON.parse(readFileSync(vendoredPath, "utf8"));
    const shared = JSON.parse(readFileSync(sharedPath, "utf8"));

    assert.deepStrictEqual(
      vendored,
      shared,
      "indexer-envio/config/aggregators.json must match shared-config/aggregators.json. " +
        "Edit the shared-config copy and copy the file to indexer-envio/config/.",
    );
  });
});
