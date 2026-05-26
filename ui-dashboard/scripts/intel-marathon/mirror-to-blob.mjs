#!/usr/bin/env node
/**
 * One-shot: mirror every .jsonl file in .intel-marathon/ to private Vercel Blob
 * as a dated backup under intel-marathon/<date>/<filename>.
 *
 * Usage (via run.sh):
 *   bash ui-dashboard/scripts/intel-marathon/run.sh mirror-to-blob
 *
 * Direct usage:
 *   BLOB_READ_WRITE_TOKEN=... node ui-dashboard/scripts/intel-marathon/mirror-to-blob.mjs
 */

import process from "node:process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { put } from "@vercel/blob";
import { privateBlobAccessHint } from "./blob-private-hint.mjs";

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!blobToken) {
  console.error("✗ BLOB_READ_WRITE_TOKEN is not set");
  process.exit(1);
}

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const SRC_DIR = join(REPO_ROOT, ".intel-marathon");
const DATE = new Date().toISOString().slice(0, 10);
const MIN_BYTES = 100;

async function main() {
  let entries;
  try {
    entries = await readdir(SRC_DIR);
  } catch (err) {
    console.error(`✗ Cannot read ${SRC_DIR}: ${err.message}`);
    process.exit(1);
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();

  if (jsonlFiles.length === 0) {
    console.error(`✗ No .jsonl files found in ${SRC_DIR}`);
    process.exit(1);
  }

  console.log(`→ Found ${jsonlFiles.length} .jsonl files in .intel-marathon/`);
  console.log(`→ Uploading to intel-marathon/${DATE}/ in Vercel Blob\n`);

  let totalBytes = 0;
  const uploaded = [];

  for (const filename of jsonlFiles) {
    const localPath = join(SRC_DIR, filename);
    const contents = await readFile(localPath);

    if (contents.length < MIN_BYTES) {
      console.log(
        `  skip ${filename} (${contents.length} bytes < ${MIN_BYTES} byte minimum)`,
      );
      continue;
    }

    const pathname = `intel-marathon/${DATE}/${filename}`;
    process.stdout.write(
      `  uploading ${filename} (${(contents.length / 1024).toFixed(1)} KB) ... `,
    );

    const { url } = await put(pathname, contents, {
      access: "private",
      contentType: "application/x-ndjson",
      addRandomSuffix: false,
      allowOverwrite: true,
      token: blobToken,
    });

    const kb = (contents.length / 1024).toFixed(1);
    console.log(`done`);
    console.log(`  ✓ uploaded ${pathname} (${kb} KB)`);
    console.log(`    ${url}`);

    totalBytes += contents.length;
    uploaded.push({ pathname, bytes: contents.length, url });
  }

  console.log(
    `\n✓ Done. ${uploaded.length} files uploaded, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total.`,
  );
  for (const { pathname, bytes } of uploaded) {
    console.log(`  ${pathname} — ${(bytes / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => {
  console.error("✗ FAILED:", err.message);
  const hint = privateBlobAccessHint(err.message);
  if (hint) console.error(`  ${hint}`);
  console.error(err.stack);
  process.exit(1);
});
