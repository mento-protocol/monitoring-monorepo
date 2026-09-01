import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";

function cleanupTemporaryFile(path, failure) {
  try {
    unlinkSync(path);
    return failure;
  } catch (error) {
    if (error?.code === "ENOENT") return failure;
    return failure ?? error;
  }
}

export function writeReportFile(path, output) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = null;
  let failure = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, output);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporary, path);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  failure = cleanupTemporaryFile(temporary, failure);
  if (failure !== null) throw failure;
}
