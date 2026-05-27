/**
 * Strip an RPC URL from an Error chain so it can't leak into Sentry / logs.
 *
 * Providers like Infura/Alchemy embed API keys in the URL **path** (e.g.
 * `/v3/<key>`), which the generic Sentry query-string scrubber doesn't
 * catch. Forno doesn't embed secrets today, but the redaction helper
 * stays defensive so adding a key-bearing provider later doesn't quietly
 * leak through every route's error capture.
 */

export function redactRpcUrl(err: unknown, rpcUrl: string): unknown {
  if (!(err instanceof Error)) {
    if (typeof err === "string") return err.replaceAll(rpcUrl, "[RPC_URL]");
    return err;
  }
  if (!containsRpcUrl(err, rpcUrl)) return err;
  const copy = new Error(err.message.replaceAll(rpcUrl, "[RPC_URL]"));
  // V8 stacks start with `Error: <message>\n    at …`, so the original
  // URL is embedded in the stack's first line. Scrub the stack string too.
  if (err.stack !== undefined) {
    copy.stack = err.stack.replaceAll(rpcUrl, "[RPC_URL]");
  }
  copy.name = err.name;
  // viem / ethers wrap the transport error as `cause`; recurse so the URL
  // can't leak through the cause chain (Sentry serializes `cause`).
  if ("cause" in err && err.cause !== undefined) {
    copy.cause = redactRpcUrl(err.cause, rpcUrl);
  }
  return copy;
}

export function containsRpcUrl(err: Error, rpcUrl: string): boolean {
  if (err.message.includes(rpcUrl)) return true;
  if (err.stack?.includes(rpcUrl)) return true;
  if (err.cause instanceof Error) return containsRpcUrl(err.cause, rpcUrl);
  if (typeof err.cause === "string") return err.cause.includes(rpcUrl);
  return false;
}
