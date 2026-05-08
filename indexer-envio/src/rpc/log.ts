// Lets RPC helpers accept either Envio's `context.log` (level-tagged in the
// hosted dashboard) or `consoleLogger` (untagged fallback for tests + any
// helper called outside an event/effect handler).

import type { Logger } from "envio";

export type RpcLogger = Logger;

const LEVELS = ["debug", "info", "warn", "error"] as const;

/** Each method re-reads `console.<level>` at call time (no `bind` cache) so
 *  tests that swap `console.warn` for a spy still capture our output. */
export const consoleLogger: RpcLogger = Object.fromEntries(
  LEVELS.map((level) => [
    level,
    (...args: Parameters<RpcLogger["warn"]>) => console[level](...args),
  ]),
) as RpcLogger;
