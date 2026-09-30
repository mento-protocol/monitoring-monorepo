import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProvider } from "./review-eval-v2-provider.mjs";

test("provider confines tools, retains full stream, and conservatively meters missing cost", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "v2-provider-test-"));
  let recorded;
  const spawnProcess = (_name, args) => {
    recorded = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Final review" }] } })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({ type: "result", result: "Final review", is_error: false, duration_ms: 5 })}\n`,
      );
      child.emit("close", 0);
    });
    return child;
  };
  try {
    const provider = createProvider({
      out,
      limit: 10,
      repoRoot: out,
      version: "test",
      spawnProcess,
    });
    const result = await provider.invoke({
      label: "review",
      prompt: "Review",
      cwd: out,
      model: "test",
      effort: "high",
      reviewer: true,
      allowedTools: ["Read", "Bash", "Agent"],
    });
    assert.equal(result.envelope.result, "Final review");
    assert.equal(result.envelope.total_cost_usd, null);
    assert.ok(result.stream.includes('"type":"assistant"'));
    assert.equal(recorded[recorded.indexOf("--tools") + 1], "Read");
    assert.equal(
      recorded[recorded.indexOf("--permission-mode") + 1],
      "dontAsk",
    );
    assert.ok(recorded.includes("--restricted"));
    assert.ok(recorded.includes("--strict-mcp-config"));
    const ledger = JSON.parse(
      readFileSync(path.join(out, "spend.json"), "utf8"),
    );
    assert.equal(ledger.calls[0].charged_usd, 5);
    assert.equal(ledger.calls[0].actual_usd, null);
    const resumed = createProvider({
      out,
      limit: 10,
      repoRoot: out,
      version: "test",
      spawnProcess,
    });
    assert.equal(resumed.ledger.calls.length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
