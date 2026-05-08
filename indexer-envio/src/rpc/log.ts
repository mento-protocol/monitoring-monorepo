// Lightweight logger plumbing so RPC helpers can emit level-tagged log lines
// (debug/info/warn/error) that Envio's hosted runtime classifies in the
// dashboard. Without this, every `console.*` call from this package collapses
// to the unleveled "stdout" stream and is ungrep-able after the fact.
//
// Envio's `Logger` (exposed as `context.log` inside handlers and effects) is
// the only path that produces a tagged record. Calls from outside an effect
// (startup checks, schema audits, lifecycle) have no Envio logger available;
// those use `consoleLogger` and stay on the unleveled path — but at least the
// production RPC hot path (1.9k lines/15min in observed catch-up logs) goes
// through the structured side and shows up under `level=warn` etc.

import type { Logger } from "envio";

/** Subset of Envio's `Logger` actually used by this package. The full
 *  `Logger` also exposes `errorWithExn(msg, exn)`; we don't need it here. */
export type RpcLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

/** Last-resort logger for callsites without an Envio `Logger` in scope.
 *  Goes to console with level routing intact — useful in tests, startup
 *  code, and any helper called outside an event/effect handler.
 *
 *  Each method re-reads `console.<level>` at call time (no bind cache) so
 *  tests that swap `console.warn` for a spy still capture our output. */
export const consoleLogger: RpcLogger = {
  debug: ((msg: string, params?: Record<string, unknown>) =>
    params === undefined
      ? console.debug(msg)
      : console.debug(msg, params)) as RpcLogger["debug"],
  info: ((msg: string, params?: Record<string, unknown>) =>
    params === undefined
      ? console.info(msg)
      : console.info(msg, params)) as RpcLogger["info"],
  warn: ((msg: string, params?: Record<string, unknown>) =>
    params === undefined
      ? console.warn(msg)
      : console.warn(msg, params)) as RpcLogger["warn"],
  error: ((msg: string, params?: Record<string, unknown>) =>
    params === undefined
      ? console.error(msg)
      : console.error(msg, params)) as RpcLogger["error"],
};
