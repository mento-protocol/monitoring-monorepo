import { existsSync, readFileSync } from "node:fs";

// Keep the existing resume policy: every address-bearing record is terminal.
export function loadProcessed(
  progressFile,
  storage = { existsSync, readFileSync },
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
        const { address } = JSON.parse(line);
        if (address) processed.add(address);
      } catch {
        /* skip malformed */
      }
    }
  }
  return { processed, exists };
}
