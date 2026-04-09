/// <reference types="mocha" />
import { strict as assert } from "assert";
import { withHyperRpcToken } from "../src/rpc";

describe("withHyperRpcToken", () => {
  const ORIGINAL_TOKEN = process.env.ENVIO_API_TOKEN;

  afterEach(() => {
    // Restore original env state after each test.
    if (ORIGINAL_TOKEN !== undefined) {
      process.env.ENVIO_API_TOKEN = ORIGINAL_TOKEN;
    } else {
      delete process.env.ENVIO_API_TOKEN;
    }
  });

  it("appends token to a bare HyperRPC URL", () => {
    process.env.ENVIO_API_TOKEN = "my-token";
    assert.equal(
      withHyperRpcToken("https://143.rpc.hypersync.xyz"),
      "https://143.rpc.hypersync.xyz/my-token",
    );
  });

  it("appends token to a HyperRPC URL with trailing slash", () => {
    process.env.ENVIO_API_TOKEN = "my-token";
    assert.equal(
      withHyperRpcToken("https://143.rpc.hypersync.xyz/"),
      "https://143.rpc.hypersync.xyz/my-token",
    );
  });

  it("skips if URL already has a path segment (already tokenized)", () => {
    process.env.ENVIO_API_TOKEN = "new-token";
    assert.equal(
      withHyperRpcToken("https://143.rpc.hypersync.xyz/existing-token"),
      "https://143.rpc.hypersync.xyz/existing-token",
    );
  });

  it("returns URL unchanged when no ENVIO_API_TOKEN is set", () => {
    delete process.env.ENVIO_API_TOKEN;
    assert.equal(
      withHyperRpcToken("https://143.rpc.hypersync.xyz"),
      "https://143.rpc.hypersync.xyz",
    );
  });

  it("returns URL unchanged for non-HyperRPC endpoints", () => {
    process.env.ENVIO_API_TOKEN = "my-token";
    assert.equal(
      withHyperRpcToken("https://forno.celo.org"),
      "https://forno.celo.org",
    );
  });

  it("returns URL unchanged for non-HyperRPC override with token set", () => {
    process.env.ENVIO_API_TOKEN = "my-token";
    assert.equal(
      withHyperRpcToken("https://rpc2.monad.xyz"),
      "https://rpc2.monad.xyz",
    );
  });

  it("works with named HyperRPC subdomains", () => {
    process.env.ENVIO_API_TOKEN = "my-token";
    assert.equal(
      withHyperRpcToken("https://monad.rpc.hypersync.xyz"),
      "https://monad.rpc.hypersync.xyz/my-token",
    );
  });
});
