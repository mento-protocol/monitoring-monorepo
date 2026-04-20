import { describe, it, expect } from "vitest";
import { redactRpcUrl, containsRpcUrl } from "../route";

const RPC_URL = "https://celo-mainnet.infura.io/v3/PRIVATE_KEY_ABC";
const PLACEHOLDER = "[RPC_URL]";

describe("redactRpcUrl — top-level Error", () => {
  it("scrubs the URL from err.message", () => {
    const err = new Error(`request to ${RPC_URL} failed`);
    const scrubbed = redactRpcUrl(err, RPC_URL);
    expect(scrubbed).toBeInstanceOf(Error);
    expect((scrubbed as Error).message).toBe(
      `request to ${PLACEHOLDER} failed`,
    );
    expect((scrubbed as Error).message).not.toContain("PRIVATE_KEY_ABC");
  });

  it("scrubs the URL from err.stack (V8 embeds message in first stack line)", () => {
    // Construct a stack that embeds the URL in the first line (the usual V8
    // shape: "Error: <message>\n    at …").
    const err = new Error(`request to ${RPC_URL} failed`);
    expect(err.stack).toContain(RPC_URL);
    const scrubbed = redactRpcUrl(err, RPC_URL) as Error;
    expect(scrubbed.stack).toBeDefined();
    expect(scrubbed.stack).not.toContain("PRIVATE_KEY_ABC");
    expect(scrubbed.stack).toContain(PLACEHOLDER);
  });

  it("preserves err.name on the copy", () => {
    const err = new TypeError(`bad args to ${RPC_URL}`);
    const scrubbed = redactRpcUrl(err, RPC_URL) as Error;
    expect(scrubbed.name).toBe("TypeError");
  });

  it("returns the original error unchanged when URL is absent", () => {
    const err = new Error("plain error with no URL");
    const scrubbed = redactRpcUrl(err, RPC_URL);
    expect(scrubbed).toBe(err);
  });
});

describe("redactRpcUrl — nested cause chain", () => {
  it("recurses into Error cause and scrubs its message", () => {
    const inner = new Error(`transport: ${RPC_URL} timed out`);
    const outer = new Error("RPC request failed", { cause: inner });
    const scrubbed = redactRpcUrl(outer, RPC_URL) as Error & { cause: Error };
    expect(scrubbed.cause).toBeInstanceOf(Error);
    expect(scrubbed.cause.message).toBe(`transport: ${PLACEHOLDER} timed out`);
    expect(scrubbed.cause.message).not.toContain("PRIVATE_KEY_ABC");
  });

  it("recurses into Error cause and scrubs its stack", () => {
    const inner = new Error(`transport: ${RPC_URL} timed out`);
    const outer = new Error("RPC request failed", { cause: inner });
    const scrubbed = redactRpcUrl(outer, RPC_URL) as Error & { cause: Error };
    expect(scrubbed.cause.stack).toBeDefined();
    expect(scrubbed.cause.stack).not.toContain("PRIVATE_KEY_ABC");
  });

  it("recurses through multi-level cause chain", () => {
    const deepest = new Error(`socket error on ${RPC_URL}`);
    const mid = new Error("transport", { cause: deepest });
    const outer = new Error("upstream", { cause: mid });
    const scrubbed = redactRpcUrl(outer, RPC_URL) as Error & {
      cause: Error & { cause: Error };
    };
    expect(scrubbed.cause.cause.message).toBe(`socket error on ${PLACEHOLDER}`);
    expect(scrubbed.cause.cause.message).not.toContain("PRIVATE_KEY_ABC");
  });

  it("handles string cause by substituting the URL in the string", () => {
    const outer = Object.assign(new Error("wrapper"), {
      cause: `inner cause mentions ${RPC_URL}`,
    });
    const scrubbed = redactRpcUrl(outer, RPC_URL) as Error & { cause: string };
    expect(scrubbed.cause).toBe(`inner cause mentions ${PLACEHOLDER}`);
  });

  it("triggers redaction even when only the nested cause contains the URL", () => {
    const inner = new Error(`${RPC_URL} unreachable`);
    const outer = new Error("clean outer message", { cause: inner });
    expect(outer.message).not.toContain(RPC_URL);
    const scrubbed = redactRpcUrl(outer, RPC_URL) as Error & { cause: Error };
    // The outer message is already clean, so it stays as-is, but the cause
    // is rewritten — the whole chain should be a fresh copy rather than the
    // original untouched error.
    expect(scrubbed).not.toBe(outer);
    expect(scrubbed.cause.message).toBe(`${PLACEHOLDER} unreachable`);
  });
});

describe("redactRpcUrl — non-Error input", () => {
  it("scrubs the URL from a plain string", () => {
    const scrubbed = redactRpcUrl(`oops: ${RPC_URL}`, RPC_URL);
    expect(scrubbed).toBe(`oops: ${PLACEHOLDER}`);
  });

  it("returns other primitives unchanged", () => {
    expect(redactRpcUrl(42, RPC_URL)).toBe(42);
    expect(redactRpcUrl(null, RPC_URL)).toBe(null);
    expect(redactRpcUrl(undefined, RPC_URL)).toBe(undefined);
  });
});

describe("containsRpcUrl", () => {
  it("detects URL in message", () => {
    expect(containsRpcUrl(new Error(`${RPC_URL} fail`), RPC_URL)).toBe(true);
  });

  it("detects URL in stack (via message embedding)", () => {
    expect(containsRpcUrl(new Error(`hit ${RPC_URL}`), RPC_URL)).toBe(true);
  });

  it("detects URL in nested Error cause", () => {
    const inner = new Error(`${RPC_URL} timeout`);
    const outer = new Error("wrap", { cause: inner });
    expect(containsRpcUrl(outer, RPC_URL)).toBe(true);
  });

  it("detects URL in string cause", () => {
    const outer = Object.assign(new Error("wrap"), {
      cause: `${RPC_URL} error`,
    });
    expect(containsRpcUrl(outer, RPC_URL)).toBe(true);
  });

  it("returns false when URL is absent everywhere", () => {
    const inner = new Error("inner clean");
    const outer = new Error("outer clean", { cause: inner });
    expect(containsRpcUrl(outer, RPC_URL)).toBe(false);
  });
});
