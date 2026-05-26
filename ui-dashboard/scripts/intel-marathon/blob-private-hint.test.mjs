import { describe, expect, it } from "vitest";
import { privateBlobAccessHint } from "./blob-private-hint.mjs";

describe("privateBlobAccessHint", () => {
  it("keeps forensic backup guidance on private Blob tokens", () => {
    const hint = privateBlobAccessHint("store does not support private access");

    expect(hint).toContain("forensic backups must stay private");
    expect(hint).toContain("BLOB_READ_WRITE_TOKEN");
    expect(hint).toContain("private Blob store");
    expect(hint).not.toContain("'public'");
  });

  it("does not add Blob access guidance for unrelated failures", () => {
    expect(privateBlobAccessHint("network timeout")).toBeNull();
  });

  it("does not match generic access errors without private-store context", () => {
    expect(privateBlobAccessHint("invalid access token")).toBeNull();
    expect(privateBlobAccessHint("EACCES: permission denied")).toBeNull();
  });
});
