import { existsSync, readFileSync } from "node:fs";

// Default resume keeps all records terminal. Explicit retries retain only non-error records.
export function loadProcessed(
  progressFile,
  { retryErrors = false, storage = { existsSync, readFileSync } } = {},
) {
  const processed = new Set();
  const exists = storage.existsSync(progressFile);
  if (exists) {
    const prior = storage
      .readFileSync(progressFile, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of prior) {
      try {
        const record = JSON.parse(line);
        const { address } = record;
        if (address && (!retryErrors || !Object.hasOwn(record, "error")))
          processed.add(address);
      } catch {
        /* skip malformed */
      }
    }
  }
  return { processed, exists };
}
