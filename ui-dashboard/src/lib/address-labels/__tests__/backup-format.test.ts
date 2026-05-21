import { describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_VERSION,
  HASH_BLOB_NAMES,
  hashBlobPathname,
  isBackupManifestV2,
  manifestPathname,
} from "@/lib/address-labels/backup-format";

const wellShapedHashEntries = HASH_BLOB_NAMES.map((name) => ({
  name,
  pathname: `address-labels-backup-2026-05-21/${name}.json`,
  sizeBytes: 1024,
}));

const wellShapedManifest = {
  version: BACKUP_MANIFEST_VERSION,
  exportedAt: "2026-05-21T03:00:00.000Z",
  hashes: wellShapedHashEntries,
};

describe("manifestPathname / hashBlobPathname", () => {
  it("manifest pathname uses per-day prefix + fixed manifest.json", () => {
    expect(manifestPathname("2026-05-21")).toBe(
      "address-labels-backup-2026-05-21/manifest.json",
    );
  });

  it("hash blob pathname uses per-day prefix + hash name", () => {
    expect(hashBlobPathname("2026-05-21", "intelDeep")).toBe(
      "address-labels-backup-2026-05-21/intelDeep.json",
    );
  });
});

describe("isBackupManifestV2 — well-shaped", () => {
  it("accepts a complete v2 manifest", () => {
    expect(isBackupManifestV2(wellShapedManifest)).toBe(true);
  });
});

describe("isBackupManifestV2 — envelope checks", () => {
  it("rejects non-objects", () => {
    expect(isBackupManifestV2(null)).toBe(false);
    expect(isBackupManifestV2("string")).toBe(false);
    expect(isBackupManifestV2(42)).toBe(false);
  });

  it("rejects a missing or wrong version field", () => {
    expect(isBackupManifestV2({ ...wellShapedManifest, version: "v1" })).toBe(
      false,
    );
    expect(
      isBackupManifestV2({ ...wellShapedManifest, version: undefined }),
    ).toBe(false);
  });

  it("rejects a missing exportedAt", () => {
    const { exportedAt, ...rest } = wellShapedManifest;
    void exportedAt;
    expect(isBackupManifestV2(rest)).toBe(false);
  });

  it("rejects a hashes field that is not an array", () => {
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes: {} })).toBe(
      false,
    );
  });
});

describe("isBackupManifestV2 — per-entry shape checks", () => {
  it("rejects an entry with an unknown name", () => {
    const hashes = [
      ...wellShapedHashEntries.slice(0, -1),
      {
        name: "intelMystery",
        pathname: "address-labels-backup-2026-05-21/intelMystery.json",
        sizeBytes: 100,
      },
    ];
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes })).toBe(false);
  });

  it("rejects an entry with a missing pathname", () => {
    const hashes = wellShapedHashEntries.map((entry, i) =>
      i === 0
        ? ({
            ...entry,
            pathname: undefined as unknown as string,
          } as typeof entry)
        : entry,
    );
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes })).toBe(false);
  });

  it("rejects an entry with a non-finite sizeBytes", () => {
    const hashes = wellShapedHashEntries.map((entry, i) =>
      i === 0 ? { ...entry, sizeBytes: Number.NaN } : entry,
    );
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes })).toBe(false);
  });
});

describe("isBackupManifestV2 — cardinality + uniqueness (codex P2)", () => {
  it("rejects a manifest missing a required hash", () => {
    // Drop `reports` — assembled snapshot would omit it and replace-mode
    // restore would leave Redis with the pre-restore reports hash intact,
    // silently defeating the route's all-or-nothing invariant.
    const hashes = wellShapedHashEntries.filter((e) => e.name !== "reports");
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes })).toBe(false);
  });

  it("rejects a manifest with a duplicated hash entry", () => {
    // Two entries for `labels` — last-write-wins on assembly, but the count
    // also means one expected hash is missing, so this is doubly broken.
    const hashes = [
      ...wellShapedHashEntries,
      {
        name: "labels" as const,
        pathname: "address-labels-backup-2026-05-21/labels-duplicate.json",
        sizeBytes: 200,
      },
    ];
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes })).toBe(false);
  });

  it("rejects an empty manifest (zero hashes)", () => {
    expect(isBackupManifestV2({ ...wellShapedManifest, hashes: [] })).toBe(
      false,
    );
  });
});
