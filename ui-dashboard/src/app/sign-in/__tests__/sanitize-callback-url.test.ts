import { describe, it, expect, vi } from "vitest";

vi.mock("@/auth", () => ({
  signIn: vi.fn(),
}));

import { sanitizeCallbackUrl } from "../page";

describe("sanitizeCallbackUrl", () => {
  it("accepts a relative path", () => {
    expect(sanitizeCallbackUrl("/address-book")).toBe("/address-book");
  });

  it("accepts a relative path with query params", () => {
    expect(sanitizeCallbackUrl("/address-book?filter=custom")).toBe(
      "/address-book?filter=custom",
    );
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(sanitizeCallbackUrl("//evil.com")).toBe("/address-book");
  });

  it("rejects absolute URLs", () => {
    expect(sanitizeCallbackUrl("https://evil.com")).toBe("/address-book");
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBe("/address-book");
  });

  it("returns default for undefined", () => {
    expect(sanitizeCallbackUrl(undefined)).toBe("/address-book");
  });

  it("returns default for empty string", () => {
    expect(sanitizeCallbackUrl("")).toBe("/address-book");
  });
});
