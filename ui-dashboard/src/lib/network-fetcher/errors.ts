/**
 * Normalizes a `Promise.allSettled` rejection reason (which may be any
 * thrown value) to an `Error` instance. Shared by the per-source derive
 * helpers so a non-`Error` throw (e.g. a rejected string) still lands in a
 * `NetworkData` error channel as a real `Error`.
 */
export function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
