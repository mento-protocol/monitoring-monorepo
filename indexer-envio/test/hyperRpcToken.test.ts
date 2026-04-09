/// <reference types="mocha" />
import { strict as assert } from "assert";
import { withHyperRpcToken, getRpcClient, _clearRpcClients } from "../src/rpc";

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

  it("returns bare HyperRPC URL unchanged when no ENVIO_API_TOKEN is set", () => {
    delete process.env.ENVIO_API_TOKEN;
    // withHyperRpcToken itself doesn't throw — the fail-fast guard lives in
    // getRpcClient(). This test verifies the function is a no-op without a token.
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

// These tests verify the fail-fast guard in getRpcClient() — they check whether
// the guard throws or allows client construction. They do NOT test RPC
// reachability; viem's createPublicClient is lazy and defers I/O to the first
// actual call.
describe("getRpcClient fail-fast guard", () => {
  const ORIGINAL_TOKEN = process.env.ENVIO_API_TOKEN;
  const ORIGINAL_RPC_42220 = process.env.ENVIO_RPC_URL_42220;
  const ORIGINAL_RPC_143 = process.env.ENVIO_RPC_URL_143;
  const ORIGINAL_RPC_10143 = process.env.ENVIO_RPC_URL_10143;

  beforeEach(() => {
    _clearRpcClients();
  });

  afterEach(() => {
    _clearRpcClients();
    if (ORIGINAL_TOKEN !== undefined) {
      process.env.ENVIO_API_TOKEN = ORIGINAL_TOKEN;
    } else {
      delete process.env.ENVIO_API_TOKEN;
    }
    if (ORIGINAL_RPC_42220 !== undefined) {
      process.env.ENVIO_RPC_URL_42220 = ORIGINAL_RPC_42220;
    } else {
      delete process.env.ENVIO_RPC_URL_42220;
    }
    if (ORIGINAL_RPC_143 !== undefined) {
      process.env.ENVIO_RPC_URL_143 = ORIGINAL_RPC_143;
    } else {
      delete process.env.ENVIO_RPC_URL_143;
    }
    if (ORIGINAL_RPC_10143 !== undefined) {
      process.env.ENVIO_RPC_URL_10143 = ORIGINAL_RPC_10143;
    } else {
      delete process.env.ENVIO_RPC_URL_10143;
    }
  });

  // --- Guard should THROW for bare HyperRPC without token ---

  it("throws when HyperRPC override is used without ENVIO_API_TOKEN", () => {
    delete process.env.ENVIO_API_TOKEN;
    process.env.ENVIO_RPC_URL_143 = "https://143.rpc.hypersync.xyz";
    assert.throws(() => getRpcClient(143), /ENVIO_API_TOKEN is not set/);
  });

  it("throws when HyperRPC default is used without ENVIO_API_TOKEN (chain 10143)", () => {
    delete process.env.ENVIO_API_TOKEN;
    delete process.env.ENVIO_RPC_URL_10143;
    assert.throws(() => getRpcClient(10143), /ENVIO_API_TOKEN is not set/);
  });

  // --- Guard should NOT throw for full-node defaults or valid HyperRPC ---

  it("does not throw when ENVIO_API_TOKEN is set for HyperRPC default (chain 10143)", () => {
    process.env.ENVIO_API_TOKEN = "test-token";
    delete process.env.ENVIO_RPC_URL_10143;
    assert.doesNotThrow(() => getRpcClient(10143));
  });

  it("does not throw for full-node default: Celo Mainnet (chain 42220)", () => {
    delete process.env.ENVIO_API_TOKEN;
    delete process.env.ENVIO_RPC_URL_42220;
    assert.doesNotThrow(() => getRpcClient(42220));
  });

  it("does not throw for full-node default: Monad Mainnet (chain 143)", () => {
    delete process.env.ENVIO_API_TOKEN;
    delete process.env.ENVIO_RPC_URL_143;
    assert.doesNotThrow(() => getRpcClient(143));
  });

  it("does not throw when a non-HyperRPC override is used", () => {
    delete process.env.ENVIO_API_TOKEN;
    process.env.ENVIO_RPC_URL_143 = "https://rpc2.monad.xyz";
    assert.doesNotThrow(() => getRpcClient(143));
  });
});
