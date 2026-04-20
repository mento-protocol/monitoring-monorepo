import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  importLabels: vi.fn().mockResolvedValue(undefined),
  getLabels: vi.fn().mockResolvedValue({}),
  upgradeEntries: vi.fn((raw: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const [address, entry] of Object.entries(raw)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name === "string") {
        result[address] = {
          name: e.name,
          tags: Array.isArray(e.tags) ? e.tags : [],
          notes: typeof e.notes === "string" ? e.notes : undefined,
          isPublic: e.isPublic === true ? true : undefined,
          updatedAt:
            typeof e.updatedAt === "string"
              ? e.updatedAt
              : new Date().toISOString(),
        };
      } else if (typeof e.label === "string") {
        const tags: string[] = [];
        if (typeof e.category === "string" && e.category.trim())
          tags.push(e.category.trim());
        result[address] = {
          name: e.label,
          tags,
          notes: typeof e.notes === "string" ? e.notes : undefined,
          isPublic: e.isPublic === true ? true : undefined,
          updatedAt:
            typeof e.updatedAt === "string"
              ? e.updatedAt
              : new Date().toISOString(),
        };
      } else {
        result[address] = {
          name: "",
          tags: [],
          updatedAt:
            typeof e.updatedAt === "string"
              ? e.updatedAt
              : new Date().toISOString(),
        };
      }
    }
    return result;
  }),
  upgradeEntry: vi.fn((raw: Record<string, unknown>) => {
    // Minimal real upgradeEntry for tests
    if (typeof raw.name === "string") {
      return {
        name: raw.name,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        notes: typeof raw.notes === "string" ? raw.notes : undefined,
        isPublic: raw.isPublic === true ? true : undefined,
        updatedAt:
          typeof raw.updatedAt === "string"
            ? raw.updatedAt
            : new Date().toISOString(),
      };
    }
    if (typeof raw.label === "string") {
      const tags: string[] = [];
      if (typeof raw.category === "string" && raw.category.trim()) {
        tags.push(raw.category.trim());
      }
      return {
        name: raw.label,
        tags,
        notes: typeof raw.notes === "string" ? raw.notes : undefined,
        isPublic: raw.isPublic === true ? true : undefined,
        updatedAt:
          typeof raw.updatedAt === "string"
            ? raw.updatedAt
            : new Date().toISOString(),
      };
    }
    return {
      name: "",
      tags: [],
      updatedAt:
        typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : new Date().toISOString(),
    };
  }),
  sanitizeEntry: vi.fn((entry: Record<string, unknown>) => entry),
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

function csvReq(csvText: string) {
  return new NextRequest("http://localhost/api/address-labels/import", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csvText,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "alice@mentolabs.xyz" },
  });
  (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

describe("POST /api/address-labels/import", () => {
  const validAddress = "0x" + "a".repeat(40);

  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(jsonReq({ chainId: 42220, labels: {} }));
    expect(res.status).toBe(401);
  });

  it("imports simple format with valid chainId (v2 schema)", async () => {
    const labels = {
      [validAddress]: {
        name: "Test",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        [validAddress]: expect.objectContaining({ name: "Test" }),
      }),
    );
  });

  it("imports simple format with legacy v1 entries (label→name)", async () => {
    const labels = {
      [validAddress]: {
        label: "Legacy",
        category: "CEX",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        [validAddress]: expect.objectContaining({
          name: "Legacy",
          tags: ["CEX"],
        }),
      }),
    );
  });

  it("deduplicates mixed-case duplicate addresses in simple JSON imports", async () => {
    const upper = validAddress.toUpperCase().replace(/^0X/, "0x");
    const labels = {
      [validAddress]: {
        name: "First",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      [upper]: {
        name: "Second",
        tags: ["Whale"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { imported: number }).imported).toBe(1);
    expect(importLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        [validAddress.toLowerCase()]: expect.objectContaining({
          name: "Second",
          tags: ["Whale"],
        }),
      }),
    );
  });

  it("imports snapshot format (v2 schema)", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          [validAddress]: {
            name: "Test",
            tags: ["Whale"],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledTimes(1);
  });

  it("imports snapshot format with legacy v1 entries", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          [validAddress]: {
            label: "Old",
            category: "DeFi",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        [validAddress]: expect.objectContaining({
          name: "Old",
          tags: ["DeFi"],
        }),
      }),
    );
  });

  it("deduplicates mixed-case duplicate addresses in snapshot JSON imports", async () => {
    const upper = validAddress.toUpperCase().replace(/^0X/, "0x");
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          [validAddress]: {
            name: "First",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
          [upper]: {
            name: "Second",
            tags: ["Whale"],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { imported: number }).imported).toBe(1);
    expect(importLabels).toHaveBeenCalledWith(
      42220,
      expect.objectContaining({
        [validAddress.toLowerCase()]: expect.objectContaining({
          name: "Second",
          tags: ["Whale"],
        }),
      }),
    );
  });

  it("rejects snapshot with invalid chainId keys", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        foo: {
          "0xabc": {
            name: "Test",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
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
          "0xabc": {
            name: "Test",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
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

  it("rejects simple format with invalid address keys", async () => {
    const res = await POST(
      jsonReq({
        chainId: 42220,
        labels: {
          notAnAddress: {
            name: "Bad",
            tags: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects snapshot format with invalid address keys", async () => {
    const res = await POST(
      jsonReq({
        exportedAt: "2026-01-01T00:00:00Z",
        chains: {
          "42220": {
            badKey: {
              name: "Bad",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects labels where entries lack both name and label fields", async () => {
    const res = await POST(
      jsonReq({
        chainId: 42220,
        labels: { "0xabc": { notes: "no name field" } },
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

  it("rejects snapshot where one chain has entries missing both name and label", async () => {
    const res = await POST(
      jsonReq({
        chains: {
          "42220": {
            "0xabc": {
              name: "Valid",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
          "143": {
            "0xdef": { notes: "missing name field" },
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(importLabels).not.toHaveBeenCalled();
  });

  describe("CSV format", () => {
    const validAddress = "0x1234567890123456789012345678901234567890";
    const validCsv = `address,name\n${validAddress},My Label`;

    it("imports a valid CSV (text/csv content-type)", async () => {
      const res = await csvReq(validCsv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      const json = (await body.json()) as { ok: boolean; imported: number };
      expect(json.ok).toBe(true);
      expect(json.imported).toBe(1);
      // Should import into both mainnet chains (42220 + 143)
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "My Label",
            tags: [],
          }),
        }),
      );
      expect(importLabels).toHaveBeenCalledWith(
        143,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "My Label",
            tags: [],
          }),
        }),
      );
    });

    it("imports CSV with tags column", async () => {
      const csv = `address,name,tags\n${validAddress},Wintermute,"Market Maker;Arbitrageur"`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "Wintermute",
            tags: ["Market Maker", "Arbitrageur"],
          }),
        }),
      );
    });

    it("allows tag-only CSV rows (empty name with tags)", async () => {
      const csv = `address,name,tags\n${validAddress},,Whale;ETH Staker`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "",
            tags: ["Whale", "ETH Staker"],
          }),
        }),
      );
    });

    it("handles CSV with extra columns (ignored)", async () => {
      const csv = `address,name,extra\n${validAddress},Team Label,ignored`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      const json = (await body.json()) as { imported: number };
      expect(json.imported).toBe(1);
    });

    it("handles columns in different order", async () => {
      const csv = `name,address\nMy Label,${validAddress}`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
    });

    it("handles Windows line endings (CRLF)", async () => {
      const csv = `address,name\r\n${validAddress},My Label\r\n`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
    });

    it("skips blank rows", async () => {
      const csv = `address,name\n${validAddress},Label\n\n`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(((await body.json()) as { imported: number }).imported).toBe(1);
    });

    it("handles quoted fields with commas", async () => {
      const csv = `address,name\n${validAddress},"Label, with comma"`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
    });

    it("merges with existing entries (preserves notes/isPublic)", async () => {
      const existingEntry = {
        name: "Old Label",
        tags: ["DeFi"],
        notes: "Important",
        isPublic: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      // Use mockResolvedValueOnce so subsequent tests get the default {} mock.
      // Called twice (once per chain: 42220 + 143).
      (getLabels as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ [validAddress.toLowerCase()]: existingEntry })
        .mockResolvedValueOnce({ [validAddress.toLowerCase()]: existingEntry });

      const res = await csvReq(validCsv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "My Label",
            // CSV with no tags column must preserve existing tags (fix #1)
            tags: ["DeFi"],
            notes: "Important",
            // isPublic must be preserved — CSV import must NOT overwrite to true
            isPublic: false,
          }),
        }),
      );
    });

    it("does not force isPublic:true on new CSV entries (no opinion)", async () => {
      const res = await csvReq(validCsv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      const callArg = (
        importLabels as ReturnType<typeof vi.fn>
      ).mock.calls.find((args: unknown[]) => args[0] === 42220)?.[1];
      const entry = callArg?.[validAddress.toLowerCase()];
      expect(entry?.isPublic).toBeUndefined();
    });

    it("returns 400 for CSV missing required columns", async () => {
      const csv = `address,label\n${validAddress},My Label`; // 'name' column missing
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
      const json = (await body.json()) as { error: string };
      expect(json.error).toMatch(/name/i);
    });

    it("returns 400 for invalid address in CSV", async () => {
      const csv = `address,name\nnot-an-address,Label`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
    });

    it("returns 400 for unterminated quoted field", async () => {
      const csv = `address,name\n${validAddress},"Broken label`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
      const json = (await body.json()) as { error: string };
      expect(json.error).toMatch(/unterminated/i);
    });

    it("returns 400 for stray quote in unquoted field", async () => {
      const csv = `address,name\n${validAddress},Bad"Label`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
      const json = (await body.json()) as { error: string };
      expect(json.error).toMatch(/quote/i);
    });

    it("returns 400 for trailing junk after closing quote", async () => {
      const csv = `address,name\n${validAddress},"Label"junk`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
      const json = (await body.json()) as { error: string };
      expect(json.error).toMatch(/trailing characters/i);
    });

    it("returns 400 for row with missing address but non-empty name", async () => {
      const csv = `address,name\n,Treasury`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
      const json = (await body.json()) as { error: string };
      expect(json.error).toMatch(/empty address/i);
    });

    it("returns 400 for empty name and no tags in CSV", async () => {
      const csv = `address,name\n${validAddress},`;
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(400);
    });

    it("returns 200 with imported:0 for CSV with header only", async () => {
      const res = await csvReq("address,name\n");
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(((await body.json()) as { imported: number }).imported).toBe(0);
    });

    it("strips UTF-8 BOM from Excel/Sheets exports", async () => {
      // Excel and Google Sheets prepend BOM (U+FEFF) to CSV exports.
      // Without stripping, the header becomes BOM+address and column detection fails.
      const BOM = "\uFEFF";
      const csv = BOM + "address,name\n" + validAddress + ",BOM Label";
      const res = await csvReq(csv);
      const body = await POST(res);
      expect(body.status).toBe(200);
      expect(((await body.json()) as { imported: number }).imported).toBe(1);
    });

    it("sniffs CSV when content-type is omitted but body looks like CSV", async () => {
      // Some upload paths send no content-type — body sniffing should detect CSV.
      const req = new NextRequest(
        "http://localhost/api/address-labels/import",
        {
          method: "POST",
          // No Content-Type header — sniffing fires
          body: `address,name\n${validAddress},My Label`,
        },
      );
      const body = await POST(req);
      expect(body.status).toBe(200);
    });

    it("returns 400 for application/json with empty body (not a CSV no-op)", async () => {
      // Regression: empty body with application/json must not silently succeed
      // as a CSV no-op (imported: 0). It's a client bug and should be rejected.
      const req = new NextRequest(
        "http://localhost/api/address-labels/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "",
        },
      );
      const body = await POST(req);
      expect(body.status).toBe(400);
    });

    it("returns 400 for application/json with CSV-looking body (not sniffed)", async () => {
      // Callers who send application/json must send valid JSON. CSV-looking
      // body with explicit application/json should return 400, not 200.
      const req = new NextRequest(
        "http://localhost/api/address-labels/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: `address,name\n${validAddress},My Label`,
        },
      );
      const body = await POST(req);
      expect(body.status).toBe(400);
    });

    it("accepts BOM-prefixed JSON payloads", async () => {
      const req = new NextRequest(
        "http://localhost/api/address-labels/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body:
            "\uFEFF" +
            JSON.stringify({
              chainId: 42220,
              labels: {
                [validAddress]: {
                  name: "My Label",
                  tags: [],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
            }),
        },
      );
      const body = await POST(req);
      expect(body.status).toBe(200);
    });
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
          [validAddress]: expect.objectContaining({ name: "My Safe" }),
        }),
      );
      expect(((await res.json()) as { imported: number }).imported).toBe(1);
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
      expect(((await res.json()) as { imported: number }).imported).toBe(2);
    });

    it("deduplicates mixed-case duplicate addresses when reporting imported count", async () => {
      const upper = validAddress.toUpperCase().replace(/^0X/, "0x");
      const gnosisSafe = [
        { address: validAddress, chainId: "42220", name: "First" },
        { address: upper, chainId: "42220", name: "Second" },
      ];
      const res = await POST(jsonReq(gnosisSafe));
      expect(res.status).toBe(200);
      expect(importLabels).toHaveBeenCalledTimes(1);
      expect(((await res.json()) as { imported: number }).imported).toBe(1);
      expect(importLabels).toHaveBeenCalledWith(
        42220,
        expect.objectContaining({
          [validAddress.toLowerCase()]: expect.objectContaining({
            name: "Second",
          }),
        }),
      );
    });

    it("succeeds with an empty array (no-op)", async () => {
      const res = await POST(jsonReq([]));
      expect(res.status).toBe(200);
      expect(importLabels).not.toHaveBeenCalled();
      expect(((await res.json()) as { imported: number }).imported).toBe(0);
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
      // serverError returns a generic message — full error is in Sentry.
      expect(body.error).toBe("Import failed");
      expect(importLabels).not.toHaveBeenCalled();
    });

    it("merges with existing entry metadata instead of overwriting", async () => {
      // Existing entry has tags/notes/isPublic set
      const existingEntry = {
        name: "Old Name",
        tags: ["Team"],
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
            name: "New Name",
            tags: ["Team"],
            notes: "Important contract",
            isPublic: true,
          }),
        }),
      );
    });
  });
});
