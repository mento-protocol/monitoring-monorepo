import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Guards the production handler-loading path, which vitest cannot exercise:
// `envio start` auto-loads `config.handlers` and then imports every `handler:`
// entry from config.yaml through its own loader. A handler registered twice
// (a second module instance of a handler file, or a second `onEvent` for the
// same event) applies every stateful update twice. The vitest harness routes
// registration through its own module graph, so only this probe observes what
// envio's loader does with the committed config.
const INDEXER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE = fileURLToPath(
  new URL("./fixtures/nativeHandlerRegistration.probe.mjs", import.meta.url),
);

describe("native handler registration", () => {
  it("runs each simulated event through its handler exactly once", () => {
    const result = spawnSync(process.execPath, [PROBE], {
      cwd: INDEXER_ROOT,
      encoding: "utf8",
      // Minimal explicit env: the subprocess is outside vitest's hermetic
      // network guard, so every RPC URL points at a closed loopback port
      // (refuses immediately; the probe counts handler executions, not RPC
      // results) and nothing else leaks in from the parent.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        ENVIO_START_BLOCK_CELO: "0",
        ENVIO_START_BLOCK_MONAD: "0",
        ENVIO_START_BLOCK_CELO_SEPOLIA: "0",
        ENVIO_START_BLOCK_MONAD_TESTNET: "0",
        ENVIO_RPC_URL_42220: "http://127.0.0.1:9",
        ENVIO_RPC_FALLBACK_URL_42220: "http://127.0.0.1:9",
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    const line = result.stdout
      .trim()
      .split("\n")
      .find((candidate) => candidate.startsWith('{"eventsProcessed"'));
    assert.ok(line, output);
    assert.deepEqual(JSON.parse(line), { eventsProcessed: 1 });
  });
});
