import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ENVIO_RUNTIME_LOG_PAGE_LIMIT = 100;

/**
 * Envio's `--level error` filter leaves some stdout-carried records in the
 * response. Keep only entries the API itself marks as errors; do not infer a
 * level from message text.
 */
export function isEnvioRuntimeError(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    (entry.level === "error" ||
      (entry.error !== null && typeof entry.error === "object"))
  );
}

export function filterEnvioRuntimeErrors(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray(payload.data)
  ) {
    throw new TypeError("Envio runtime-log JSON must contain a data array");
  }
  if (payload.data.length >= ENVIO_RUNTIME_LOG_PAGE_LIMIT) {
    throw new RangeError(
      `Envio returned the full ${ENVIO_RUNTIME_LOG_PAGE_LIMIT}-record page; the requested window may contain unreturned errors. Narrow --since and retry`,
    );
  }
  return { ...payload, data: payload.data.filter(isEnvioRuntimeError) };
}

function main() {
  const raw = readFileSync(0, "utf8");
  const payload = JSON.parse(raw);
  process.stdout.write(
    `${JSON.stringify(filterEnvioRuntimeErrors(payload), null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `deploy:indexer:logs --errors-only: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
