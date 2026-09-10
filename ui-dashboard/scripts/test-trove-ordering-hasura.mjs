#!/usr/bin/env node
// Run only against this script's disposable Compose project. Never accepts an endpoint.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const compose = fileURLToPath(
  new URL("./fixtures/trove-ordering.compose.yml", import.meta.url),
);
const project = `trove-ordering-${process.pid}`;
const endpoint = "http://127.0.0.1:8080";
const fixturePassword = randomBytes(16).toString("hex");
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, TROVE_ORDERING_FIXTURE_PASSWORD: fixturePassword },
  });
const run = (...args) =>
  docker(["compose", "-p", project, "-f", compose, ...args]);
// Refuse any service already owning the required port. This test never reuses
// an unknown Hasura endpoint or modifies another project's data.
const { createServer } = await import("node:net");
const guard = createServer();
await new Promise((resolve, reject) => {
  guard.once("error", reject);
  guard.listen(8080, "127.0.0.1", resolve);
});
await new Promise((resolve) => guard.close(resolve));
async function request(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  assert.ok(response.ok && !result.errors, JSON.stringify(result));
  return result;
}
const source = readFileSync(
  new URL("../src/lib/queries/liquity.ts", import.meta.url),
  "utf8",
);
function query(name) {
  const value = source.match(
    new RegExp(`export const ${name} = ` + "`([\\s\\S]*?)`;"),
  )?.[1];
  assert.ok(
    value && !value.includes("${"),
    "Expected a literal production query",
  );
  return value;
}
try {
  run("up", "-d", "--wait", "--wait-timeout", "120");
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      healthy = (
        await fetch(`${endpoint}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        })
      ).ok;
    } catch {}
    if (healthy) break;
    await setTimeout(1_000);
  }
  assert.ok(healthy, "Hasura did not become healthy");
  await request("/v1/metadata", {
    type: "pg_add_source",
    args: {
      name: "default",
      configuration: {
        connection_info: { database_url: { from_env: "PG_DATABASE_URL" } },
      },
    },
  });
  await request("/v2/query", {
    type: "run_sql",
    args: {
      source: "default",
      sql: `
    CREATE TABLE "TroveOperationEvent" (
      id text PRIMARY KEY, "instanceId" text NOT NULL, "troveId" text NOT NULL,
      operation integer NOT NULL, "collChange" bigint NOT NULL, "debtChange" bigint NOT NULL,
      "annualInterestRate" bigint NOT NULL, "debtIncreaseFromUpfrontFee" bigint NOT NULL,
      timestamp bigint NOT NULL, "blockNumber" bigint NOT NULL, "logIndex" integer NOT NULL, "txHash" text NOT NULL
    );
    INSERT INTO "TroveOperationEvent"
      SELECT '42220_100_' || n, 'fixture', 'logs', 2, 0, 0, 0, 0, 2000, 100, n, '0x' || n
      FROM generate_series(100, 1098) AS n;
    INSERT INTO "TroveOperationEvent"
      SELECT '42220_99_' || n, 'fixture', 'logs', 2, 0, 0, 0, 0, 1000, 99, n, '0x' || n
      FROM generate_series(9, 10) AS n;
    INSERT INTO "TroveOperationEvent"
      SELECT '42220_' || n || '_0', 'fixture', 'blocks', 2, 0, 0, 0, 0, 2000, n, 0, '0x' || n
      FROM generate_series(100, 1098) AS n;
    INSERT INTO "TroveOperationEvent"
      SELECT '42220_' || n || '_0', 'fixture', 'blocks', 2, 0, 0, 0, 0, 1000, n, 0, '0x' || n
      FROM generate_series(9, 10) AS n;
    INSERT INTO "TroveOperationEvent" VALUES ('other', 'other-instance', 'logs', 2, 0, 0, 0, 0, 9999, 9999, 0, '0xother');
  `,
    },
  });
  await request("/v1/metadata", {
    type: "pg_track_table",
    args: {
      source: "default",
      table: { schema: "public", name: "TroveOperationEvent" },
    },
  });
  const receipts = [];
  for (const troveId of ["logs", "blocks"]) {
    const variables = { instanceId: "fixture", troveId, limit: 1000 };
    const numeric = (
      await request("/v1/graphql", {
        query: query("CDP_TROVE_OPERATIONS_NUMERIC"),
        variables,
      })
    ).data.TroveOperationEvent;
    const legacy = (
      await request("/v1/graphql", {
        query: query("CDP_TROVE_OPERATIONS"),
        variables,
      })
    ).data.TroveOperationEvent;
    const ordinal = (row) =>
      Number(troveId === "logs" ? row.logIndex : row.blockNumber);
    assert.deepEqual(numeric.map(ordinal), [
      ...Array.from({ length: 999 }, (_, i) => 1098 - i),
      10,
    ]);
    assert.equal(numeric.length, 1000);
    assert.ok(!numeric.some((row) => row.id === "other"));
    // A controlled case around the lexical digit boundary must differ from
    // the production numeric result, demonstrating server-side selection.
    const boundary10 = troveId === "logs" ? "42220_99_10" : "42220_10_0";
    const boundary9 = troveId === "logs" ? "42220_99_9" : "42220_9_0";
    assert.ok(numeric.some((row) => row.id === boundary10));
    assert.ok(!numeric.some((row) => row.id === boundary9));
    assert.ok(legacy.some((row) => row.id === boundary9));
    assert.ok(!legacy.some((row) => row.id === boundary10));
    receipts.push({
      troveId,
      rows: numeric.length,
      first: numeric[0].id,
      last: numeric.at(-1).id,
      numericIncludes10Excludes9: true,
      legacyIncludes9Excludes10: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        hasuraImage: "hasura/graphql-engine:v2.46.0",
        fixtureRows: 2003,
        querySource: "src/lib/queries/liquity.ts",
        receipts,
      },
      null,
      2,
    ),
  );
} finally {
  // Removes only the uniquely named project created above; its DB uses tmpfs.
  run("down");
}
