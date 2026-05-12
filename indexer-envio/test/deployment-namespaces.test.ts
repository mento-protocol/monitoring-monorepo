import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("deployment namespace map", () => {
  it("keeps the vendored indexer copy in sync with shared-config", () => {
    const vendoredPath = join(
      import.meta.dirname,
      "..",
      "config",
      "deployment-namespaces.json",
    );
    const sharedPath = join(
      import.meta.dirname,
      "..",
      "..",
      "shared-config",
      "deployment-namespaces.json",
    );

    const vendoredNamespaces = JSON.parse(readFileSync(vendoredPath, "utf8"));
    const sharedNamespaces = JSON.parse(readFileSync(sharedPath, "utf8"));

    assert.deepStrictEqual(
      vendoredNamespaces,
      sharedNamespaces,
      "indexer-envio/config/deployment-namespaces.json must match shared-config/deployment-namespaces.json",
    );
  });
});
