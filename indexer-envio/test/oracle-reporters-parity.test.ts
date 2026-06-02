import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("oracle-reporters.json", () => {
  it("keeps the vendored indexer copy in sync with shared-config", () => {
    const vendoredPath = join(
      import.meta.dirname,
      "..",
      "config",
      "oracle-reporters.json",
    );
    const sharedPath = join(
      import.meta.dirname,
      "..",
      "..",
      "shared-config",
      "oracle-reporters.json",
    );

    const vendored = JSON.parse(readFileSync(vendoredPath, "utf8"));
    const shared = JSON.parse(readFileSync(sharedPath, "utf8"));

    assert.deepStrictEqual(
      vendored,
      shared,
      "indexer-envio/config/oracle-reporters.json must match shared-config/oracle-reporters.json. " +
        "Edit the shared-config copy and copy the file to indexer-envio/config/.",
    );
  });
});
