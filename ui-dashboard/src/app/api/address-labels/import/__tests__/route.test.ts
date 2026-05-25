import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

// Stub Redis-backed entry-points (`importLabels` / `getLabels`); pull the real
// shared helpers (`upgradeEntries`, `sanitizeEntry`, `ARKHAM_TAG`) so this
// suite observes the production upgrade + sanitize contract.
vi.mock("@/lib/address-labels", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-labels-shared")
  >("@/lib/address-labels-shared");
  return {
    importLabels: vi.fn().mockResolvedValue(undefined),
    replaceLabels: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue({}),
    mergeEntries: shared.mergeEntries,
    upgradeEntries: shared.upgradeEntries,
    upgradeEntry: shared.upgradeEntry,
    sanitizeEntry: shared.sanitizeEntry,
    ARKHAM_TAG: shared.ARKHAM_TAG,
  };
});

vi.mock("@/lib/address-reports", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-reports-shared")
  >("@/lib/address-reports-shared");
  return {
    importReports: vi.fn().mockResolvedValue(undefined),
    replaceReports: vi.fn().mockResolvedValue(undefined),
    upgradeReports: shared.upgradeReports,
    MAX_BODY_LENGTH: shared.MAX_BODY_LENGTH,
    MAX_TITLE_LENGTH: shared.MAX_TITLE_LENGTH,
  };
});

vi.mock("@/lib/address-label-restore-writes", () => ({
  importSnapshotHashes: vi.fn().mockResolvedValue(undefined),
  replaceSnapshotHashes: vi.fn().mockResolvedValue(undefined),
}));

import { getAuthSession } from "@/auth";
import { importLabels, getLabels } from "@/lib/address-labels";
import { importReports } from "@/lib/address-reports";
import { importSnapshotHashes } from "@/lib/address-label-restore-writes";

type ImportedCounts = { addresses: number };

async function getImported(res: Response): Promise<ImportedCounts> {
  const json = (await res.json()) as { imported?: ImportedCounts };
  return json.imported ?? { addresses: 0 };
}

function jsonReq(body: unknown, contentType = "application/json") {
  return new NextRequest("http://localhost/api/address-labels/import", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
}

function csvReq(csvText: string, contentType = "text/csv") {
  return new NextRequest("http://localhost/api/address-labels/import", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: csvText,
  });
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — wipes implementations so a prior
  // `mockRejectedValue` on `importLabels` doesn't bleed into the next test.
  vi.resetAllMocks();
  (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "alice@mentolabs.xyz" },
  });
  (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (importLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (importReports as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (importSnapshotHashes as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
});

describe("POST /api/address-labels/import", () => {
  const validAddress = "0x" + "a".repeat(40);
  const addr2 = "0x" + "b".repeat(40);

  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(jsonReq({ labels: {} }));
    expect(res.status).toBe(401);
  });

  it("imports the simple format ({ labels })", async () => {
    const labels = {
      [validAddress]: {
        name: "Alice",
        tags: ["whale"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    const res = await POST(jsonReq({ labels }));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
    expect(importLabels).toHaveBeenCalledTimes(1);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].name).toBe("Alice");
  });

  it("ignores chainId in simple format (back-compat)", async () => {
    const labels = {
      [validAddress]: {
        name: "Alice",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
  });

  it("imports the new snapshot format ({ addresses })", async () => {
    const res = await POST(
      jsonReq({
        exportedAt: "2026-01-01T00:00:00Z",
        addresses: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
          [addr2]: {
            name: "Bob",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(2);
  });

  it("imports legacy snapshot ({ global, chains }) by merging into a flat map", async () => {
    const res = await POST(
      jsonReq({
        exportedAt: "2026-01-01T00:00:00Z",
        global: {
          [validAddress]: {
            name: "Cross-chain",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
        chains: {
          "42220": {
            [addr2]: {
              name: "Celo",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(2);
  });

  it("snapshot WITHOUT `reports` parses without error (back-compat for old backups)", async () => {
    // Acceptance criterion: restoring a pre-#339 snapshot must not throw.
    // The labels-only path is the canonical old-snapshot shape.
    const res = await POST(
      jsonReq({
        exportedAt: "2026-03-01T00:00:00Z",
        addresses: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-03-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(importSnapshotHashes).toHaveBeenCalledTimes(1);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("snapshot WITH `reports` restores both labels and reports", async () => {
    const res = await POST(
      jsonReq({
        exportedAt: "2026-05-01T00:00:00Z",
        addresses: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-05-01T00:00:00Z",
          },
        },
        reports: {
          [validAddress]: {
            body: "Investigation",
            authorEmail: "alice@mentolabs.xyz",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-30T00:00:00Z",
            version: 2,
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
    expect(importSnapshotHashes).toHaveBeenCalledTimes(1);
    const [snapshotArg] = (importSnapshotHashes as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    const reportArg = snapshotArg.reports;
    expect(reportArg).toBeDefined();
    const restored = reportArg[validAddress.toLowerCase()];
    expect(restored.body).toBe("Investigation");
    // Server-controlled metadata is re-stamped: importer's email becomes
    // the authoritative authorEmail, source is "import", version resets to 1.
    // The snapshot's spoof attempts (alice@... at v2) must NOT survive.
    expect(restored.authorEmail).toBe("alice@mentolabs.xyz");
    expect(restored.source).toBe("import");
    expect(restored.version).toBe(1);
  });

  it("re-stamps server-controlled report metadata with the importer's session email", async () => {
    // A session-authenticated user must NOT be able to forge another
    // user's authorEmail/source/version/timestamps via a crafted
    // snapshot. Restore re-stamps those fields with the session's email
    // + "import" source + version 1 + now(). Originally flagged by
    // cursor[bot] (CHANGES_REQUESTED on 45384a0).
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: {
            body: "x",
            authorEmail: "victim@mentolabs.xyz",
            source: "claude",
            createdAt: "2020-01-01T00:00:00Z",
            updatedAt: "2020-01-01T00:00:00Z",
            version: 99,
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(importSnapshotHashes).toHaveBeenCalledTimes(1);
    const [snapshotArg] = (importSnapshotHashes as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    const reportArg = snapshotArg.reports;
    expect(reportArg).toBeDefined();
    const restored = reportArg[validAddress.toLowerCase()];
    expect(restored.authorEmail).toBe("alice@mentolabs.xyz");
    expect(restored.source).toBe("import");
    expect(restored.version).toBe(1);
    expect(restored.createdAt).not.toBe("2020-01-01T00:00:00Z");
    expect(restored.updatedAt).not.toBe("2020-01-01T00:00:00Z");
  });

  it("snapshot with ONLY `reports` (no labels) still restores reports", async () => {
    // Routes through handleSnapshot via the reports-key recognition in
    // isSnapshot — without it the body would fall through to
    // handleSimpleFormat and 400 on the missing `labels` field.
    const res = await POST(
      jsonReq({
        exportedAt: "2026-05-01T00:00:00Z",
        reports: {
          [validAddress]: {
            body: "Investigation only",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-30T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
    expect(importSnapshotHashes).toHaveBeenCalledTimes(1);
    const [snapshotArg] = (importSnapshotHashes as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(snapshotArg.labels).toBeUndefined();
    expect(snapshotArg.reports[validAddress.toLowerCase()].body).toBe(
      "Investigation only",
    );
  });

  it("rejects a snapshot whose `reports` key is not a plain object", async () => {
    const res = await POST(
      jsonReq({
        addresses: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
        reports: "not an object",
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose `reports` key has an invalid address", async () => {
    const res = await POST(
      jsonReq({
        reports: {
          "not-an-address": {
            body: "x",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose report has an empty body (live editor invariant)", async () => {
    // Restore must enforce the same invariants as live edits — a corrupted
    // / hand-edited blob with `body: ""` would otherwise persist a record
    // the editor and live API would never accept.
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: {
            body: "",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose report has a missing/non-string body", async () => {
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: {
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose report exceeds MAX_BODY_LENGTH", async () => {
    // 50,001 chars → over the documented 50KB cap that the live editor
    // enforces. Restore path must enforce the same cap.
    const oversized = "x".repeat(50_001);
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: {
            body: oversized,
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose report has an array payload", async () => {
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: ["not an object"],
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose report has an oversized title", async () => {
    const res = await POST(
      jsonReq({
        reports: {
          [validAddress]: {
            body: "ok",
            title: "t".repeat(201),
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importReports).not.toHaveBeenCalled();
  });

  it("rejects the ambiguous `{ labels, reports }` mixed shape with 400", async () => {
    // After widening `isSnapshot` to recognise reports-only payloads, a
    // legacy simple-format shape with reports tagged on (`{ labels: {...},
    // reports: {...} }`) routes to handleSnapshot. handleSnapshot reads
    // `addresses`, not `labels` — so without an explicit guard the labels
    // would be silently dropped and the caller would see 200 / addresses=0.
    // The route now returns 400 to surface the contradiction.
    const res = await POST(
      jsonReq({
        labels: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
        reports: {
          [validAddress]: {
            body: "x",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
            version: 1,
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
    expect(importReports).not.toHaveBeenCalled();
  });

  it("imports the Gnosis Safe format (chainId field is ignored)", async () => {
    const res = await POST(
      jsonReq([
        { address: validAddress, chainId: "42220", name: "My Safe" },
        { address: addr2, chainId: "42220", name: "Bob's Safe" },
      ]),
    );
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(2);
  });

  it("rejects an invalid simple-format payload (labels not an object)", async () => {
    const res = await POST(jsonReq({ labels: "not-object" }));
    expect(res.status).toBe(400);
  });

  it("treats JSON media types case-insensitively without CSV sniffing", async () => {
    const res = await POST(
      jsonReq("address,name\nnot-json,Alice", "Application/JSON"),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("does not treat invalid JSON media-type prefixes as JSON", async () => {
    const csv = `address,name,tags\n${validAddress},Alice,whale`;
    const res = await POST(csvReq(csv, "application/jsonfoo"));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
  });

  it("strips arkham provenance from user imports (legacy tag)", async () => {
    const res = await POST(
      jsonReq({
        labels: {
          [validAddress]: {
            name: "Alice",
            tags: ["arkham", "whale"],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].tags).toEqual(["whale"]);
    expect(arg[validAddress.toLowerCase()].source).toBeUndefined();
  });

  it("strips arkham source field from user imports", async () => {
    const res = await POST(
      jsonReq({
        labels: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            source: "arkham",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].source).toBeUndefined();
  });

  it("preserves prior notes/isPublic on re-import (merge with existing)", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      [validAddress.toLowerCase()]: {
        name: "Old",
        tags: [],
        notes: "carry me",
        isPublic: true,
        updatedAt: "2025-01-01T00:00:00Z",
      },
    });
    const res = await POST(
      jsonReq({
        labels: {
          [validAddress]: {
            name: "New",
            tags: ["whale"],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].notes).toBe("carry me");
    expect(arg[validAddress.toLowerCase()].isPublic).toBe(true);
    expect(arg[validAddress.toLowerCase()].name).toBe("New");
  });

  it("returns 500 when importLabels throws", async () => {
    (importLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis offline"),
    );
    const res = await POST(
      jsonReq({
        labels: {
          [validAddress]: {
            name: "Alice",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /api/address-labels/import — CSV", () => {
  const validAddress = "0x" + "a".repeat(40);
  const addr2 = "0x" + "b".repeat(40);

  it("imports a CSV (no chainId column)", async () => {
    const csv = `address,name,tags\n${validAddress},Alice,whale;defi`;
    const res = await POST(csvReq(csv));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].tags).toEqual(["whale", "defi"]);
  });

  it("treats CSV media types case-insensitively", async () => {
    const csv = `address,name,tags\n${validAddress},Alice,whale`;
    const res = await POST(csvReq(csv, "Text/CSV; Charset=UTF-8"));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
  });

  it("rejects oversized CSV without a Content-Length header", async () => {
    const req = csvReq(`address,name,tags\n${"x".repeat(4 * 1024 * 1024)}`);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("ignores the legacy chainId column (back-compat)", async () => {
    const csv = `address,name,tags,chainId\n${validAddress},Alice,,42220\n${addr2},Bob,,1`;
    const res = await POST(csvReq(csv));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(2);
  });

  it("dedupes the same address across rows (last-wins)", async () => {
    const csv = `address,name,tags\n${validAddress},First,\n${validAddress},Second,`;
    const res = await POST(csvReq(csv));
    expect(res.status).toBe(200);
    const counts = await getImported(res);
    expect(counts.addresses).toBe(1);
    const [arg] = (importLabels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg[validAddress.toLowerCase()].name).toBe("Second");
  });

  it("rejects malformed CSV", async () => {
    const csv = `address,name\n${validAddress},"unterminated`;
    const res = await POST(csvReq(csv));
    expect(res.status).toBe(400);
  });

  it("rejects CSV missing required columns", async () => {
    const csv = `address,whatever\n${validAddress},Alice`;
    const res = await POST(csvReq(csv));
    expect(res.status).toBe(400);
  });
});
