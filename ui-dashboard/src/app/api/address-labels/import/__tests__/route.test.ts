import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  importLabels: vi.fn().mockResolvedValue(undefined),
  getLabels: vi.fn().mockResolvedValue({}),
}));

import { getAuthSession } from "@/auth";
import { importLabels, getLabels } from "@/lib/address-labels";

function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/address-labels/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "alice@mentolabs.xyz" },
  });
});

describe("POST /api/address-labels/import", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(jsonReq({ chainId: 42220, labels: {} }));
    expect(res.status).toBe(401);
  });

  it("imports simple format with valid chainId", async () => {
    const labels = {
      "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledWith(42220, labels);
  });

  it("imports snapshot format", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledTimes(1);
  });

  it("rejects snapshot with invalid chainId keys", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        foo: { "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" } },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("foo");
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects snapshot with negative chainId keys", async () => {
    const snapshot = {
      chains: {
        "-1": {
          "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(400);
  });

  it("rejects simple format with invalid chainId", async () => {
    const res = await POST(jsonReq({ chainId: -5, labels: {} }));
    expect(res.status).toBe(400);
  });

  it("rejects simple format with invalid labels shape", async () => {
    const res = await POST(jsonReq({ chainId: 42220, labels: "not-object" }));
    expect(res.status).toBe(400);
  });

  it("rejects labels where entries lack a label field", async () => {
    const res = await POST(
      jsonReq({
        chainId: 42220,
        labels: { "0xabc": { notes: "no label field" } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects snapshot with null chain payload", async () => {
    const res = await POST(jsonReq({ chains: { "42220": null } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("42220");
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects snapshot with non-label-map chain payload", async () => {
    const res = await POST(jsonReq({ chains: { "42220": "not-a-map" } }));
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects snapshot where one chain has entries missing label", async () => {
    const res = await POST(
      jsonReq({
        chains: {
          "42220": {
            "0xabc": { label: "Valid", updatedAt: "2026-01-01T00:00:00Z" },
          },
          "143": {
            "0xdef": { notes: "missing label field" },
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  describe("Gnosis Safe format", () => {
    const validAddress = "0x" + "a".repeat(40);

    it("imports a valid Gnosis Safe array", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "My Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(200);
      expect(importLabels).toHaveBeenCalledTimes(1);
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress]: expect.objectContaining({ label: "My Safe" }),
        }),
      );
    });

    it("imports multiple entries grouped by chainId", async () => {
      const addr2 = "0x" + "b".repeat(40);
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "Celo Safe" },
        { address: addr2, chainId: "1", name: "Mainnet Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(200);
      expect(importLabels).toHaveBeenCalledTimes(2);
    });

    it("succeeds with an empty array (no-op)", async () => {
      const res = await POST(jsonReq([]));
      expect(res.status).toBe(200);
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects an entry with an invalid chainId", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "not-a-number", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("chainId");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects an entry with a negative chainId", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "-1", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects scientific-notation chainId strings (e.g. '1e3')", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "1e3", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("chainId");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects hex chainId strings (e.g. '0x1')", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "0x1", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("chainId");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects whitespace-padded chainId strings (e.g. ' 42220 ')", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: " 42220 ", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("chainId");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects an entry with an invalid address", async () => {
      const gnosisSafe = [
        { address: "not-an-address", chainId: "42220", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("address");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects an array where one element is missing the name field", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "42220" }, // missing name
      ];
      const res = await POST(jsonReq(gnosisSafe));
      // Falls through to simple-format validation since isGnosisSafeFormat returns false
      expect(res.status).toBe(400);
    });

    it("rejects an entry with an empty name", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("empty name");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("rejects an entry with a whitespace-only name", async () => {
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "   " },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("empty name");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("returns 500 and does not import if getLabels throws", async () => {
      (getLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Redis connection failed"),
      );
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "Safe" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Redis connection failed");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("merges with existing label metadata instead of overwriting", async () => {
      // Existing label has category/notes/isPublic set
      const existingEntry = {
        label: "Old Name",
        category: "Team",
        notes: "Important contract",
        isPublic: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      (getLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        [validAddress.toLowerCase()]: existingEntry,
      });

      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "New Name" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(200);

      // importLabels should be called with merged entry preserving existing metadata
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress]: expect.objectContaining({
            label: "New Name",
            category: "Team",
            notes: "Important contract",
            isPublic: true,
          }),
        }),
      );
    });
  });
});
