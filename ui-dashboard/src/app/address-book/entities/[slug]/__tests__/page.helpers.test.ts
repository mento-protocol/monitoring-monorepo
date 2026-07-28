import { describe, it, expect } from "vitest";
import {
  HANDLE_RE,
  buildExternalLinks,
  safeHttpUrl,
} from "../_lib/entity-helpers";
import type { IntelEntityRecord } from "@/lib/intel-entities";

describe("safeHttpUrl", () => {
  it("returns the URL for https://", () => {
    expect(safeHttpUrl("https://openocean.finance")).toBe(
      "https://openocean.finance",
    );
  });
  it("returns the URL for http://", () => {
    expect(safeHttpUrl("http://example.org")).toBe("http://example.org");
  });
  it("rejects javascript: URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  });
  it("rejects data: URLs", () => {
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
  });
  it("rejects malformed URLs", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
  });
  it("returns null for empty / null / undefined", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});

describe("HANDLE_RE", () => {
  it("accepts alphanumeric handles", () => {
    expect(HANDLE_RE.test("openocean")).toBe(true);
    expect(HANDLE_RE.test("user_123")).toBe(true);
    expect(HANDLE_RE.test("a.b-c")).toBe(true);
  });
  it("rejects path-traversal / URL-injection attempts", () => {
    expect(HANDLE_RE.test("user/../admin")).toBe(false);
    expect(HANDLE_RE.test("user?x=1")).toBe(false);
    expect(HANDLE_RE.test("javascript:alert(1)")).toBe(false);
    expect(HANDLE_RE.test("user@host")).toBe(false);
  });
  it("rejects empty + too-long handles", () => {
    expect(HANDLE_RE.test("")).toBe(false);
    expect(HANDLE_RE.test("a".repeat(129))).toBe(false);
  });
});

const baseEntity: IntelEntityRecord = {
  slug: "openocean",
  fetchedAt: "2026-05-20T00:00:00Z",
  name: "OpenOcean",
  note: "",
  id: "openocean",
  customized: false,
  type: "cex",
  service: null,
  addresses: null,
  website: null,
  twitter: null,
  crunchbase: null,
  linkedin: null,
  populatedTags: null,
};

describe("buildExternalLinks", () => {
  it("includes a valid website URL", () => {
    const links = buildExternalLinks({
      ...baseEntity,
      website: "https://openocean.finance",
    });
    expect(links).toEqual([
      { label: "Website", href: "https://openocean.finance" },
    ]);
  });
  it("drops javascript: website URLs", () => {
    const links = buildExternalLinks({
      ...baseEntity,
      website: "javascript:alert(1)",
    });
    expect(links).toEqual([]);
  });
  it("builds twitter / crunchbase / linkedin handles into URL prefixes", () => {
    const links = buildExternalLinks({
      ...baseEntity,
      twitter: "openocean",
      crunchbase: "openocean-9859",
      linkedin: "openocean",
    });
    expect(links).toEqual([
      { label: "Twitter", href: "https://twitter.com/openocean" },
      {
        label: "Crunchbase",
        href: "https://www.crunchbase.com/organization/openocean-9859",
      },
      { label: "LinkedIn", href: "https://www.linkedin.com/company/openocean" },
    ]);
  });
  it("drops handles that fail the validation regex", () => {
    const links = buildExternalLinks({
      ...baseEntity,
      twitter: "user/../admin",
      crunchbase: "user?x=1",
    });
    expect(links).toEqual([]);
  });
});
