#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const LIVE_HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

if (!process.env.NEXT_PUBLIC_HASURA_URL) {
  process.env.NEXT_PUBLIC_HASURA_URL = LIVE_HASURA_URL;
  process.stderr.write(
    `[dashboard:dev] NEXT_PUBLIC_HASURA_URL not set; using live Envio endpoint ${LIVE_HASURA_URL}\n`,
  );
}

const child = spawn(
  process.execPath,
  [nextBin, "dev", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("error", (err) => {
  process.stderr.write(
    `[dashboard:dev] failed to start next dev: ${err.message}\n`,
  );
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
