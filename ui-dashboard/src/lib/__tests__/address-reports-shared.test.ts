import { describe, expect, it } from "vitest";

import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeReportInput,
  upgradeReport,
} from "@/lib/address-reports-shared";

describe("sanitizeReportInput", () => {
  it("rejects non-string body", () => {
    const out = sanitizeReportInput({ body: 123 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/body must be a string/);
  });

  it("rejects body that exceeds the size cap", () => {
    const tooBig = "a".repeat(MAX_BODY_LENGTH + 1);
    const out = sanitizeReportInput({ body: tooBig });
    expect(out.ok).toBe(false);
    if (!out.ok)
      expect(out.error).toMatch(
        new RegExp(String(MAX_BODY_LENGTH).slice(0, 3)),
      );
  });

  it("rejects whitespace-only body", () => {
    const out = sanitizeReportInput({ body: "   \n\t  " });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/non-empty/);
  });

  it("accepts a body at the exact cap (boundary)", () => {
    const exact = "a".repeat(MAX_BODY_LENGTH);
    const out = sanitizeReportInput({ body: exact });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.body.length).toBe(MAX_BODY_LENGTH);
  });

  it("trims the title and drops it when empty after trim", () => {
    const out = sanitizeReportInput({ body: "x", title: "   " });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.title).toBeUndefined();
  });

  it("truncates an over-long title to the cap", () => {
    const longTitle = "t".repeat(MAX_TITLE_LENGTH + 50);
    const out = sanitizeReportInput({ body: "x", title: longTitle });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.title?.length).toBe(MAX_TITLE_LENGTH);
  });

  it("rejects a non-string title when provided", () => {
    const out = sanitizeReportInput({ body: "x", title: 42 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/title/);
  });

  it("preserves an in-bounds body verbatim (no auto-trim)", () => {
    // Markdown indentation matters — leading whitespace is significant in
    // code blocks. Sanitize must not silently `.trim()` user content.
    const body = "  # heading\n\n```\n  fenced code\n```\n";
    const out = sanitizeReportInput({ body });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.body).toBe(body);
  });
});

describe("upgradeReport", () => {
  it("defaults missing version to 1 and timestamps to now", () => {
    const before = Date.now();
    const r = upgradeReport({ body: "x" });
    const after = Date.now();
    expect(r.version).toBe(1);
    const created = Date.parse(r.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1);
    expect(created).toBeLessThanOrEqual(after + 1);
    expect(r.updatedAt).toBe(r.createdAt);
  });

  it("floors a fractional version", () => {
    const r = upgradeReport({ body: "x", version: 3.7 });
    expect(r.version).toBe(3);
  });

  it("rejects an invalid source value (defaults to undefined)", () => {
    const r = upgradeReport({ body: "x", source: "not-a-source" });
    expect(r.source).toBeUndefined();
  });

  it("preserves a valid source value", () => {
    const r = upgradeReport({ body: "x", source: "claude" });
    expect(r.source).toBe("claude");
  });
});
