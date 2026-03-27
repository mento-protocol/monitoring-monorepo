/// <reference types="mocha" />
import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makePoolId } from "../src/helpers.ts";

/** Shorthand: create a namespaced pool ID for chainId 42220. */
const pid = (addr: string): string => makePoolId(42220, addr);

describe("deployment namespace map", () => {
  it("keeps the vendored indexer copy in sync with shared-config", () => {
    const vendoredPath = join(
      __dirname,
      "..",
      "config",
      "deployment-namespaces.json",
    );
    const sharedPath = join(
      __dirname,
      "..",
      "..",
      "shared-config",
      "deployment-namespaces.json",
    );

    const vendoredNamespaces = JSON.parse(readFileSync(vendoredPath, "utf8"));
    const sharedNamespaces = JSON.parse(readFileSync(sharedPath, "utf8"));

    assert.deepEqual(
      vendoredNamespaces,
      sharedNamespaces,
      "indexer-envio/config/deployment-namespaces.json must match shared-config/deployment-namespaces.json",
    );
  });
});
