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

  // These chars are dangerous in the pathname (path-normalization bypasses)
  // but legitimate in query strings — email filters, URL-shaped param values.
  it.each([
    ["@ in query", "/address-book?owner=alice@mentolabs.xyz"],
    ["%2f in query", "/address-book?path=%2Ffoo"],
    ["%5c in query", "/address-book?path=%5Cfoo"],
    ["%252f in query", "/address-book?path=%252Ffoo"],
  ])("accepts %s", (_label, input) => {
    expect(sanitizeCallbackUrl(input)).toBe(input);
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

  // P5-04 fuzz — browsers normalize `\` to `/`, tab/CR/LF get stripped by
  // URL parsers but can smuggle through some middleware, and `@` introduces
  // a user-info component that reparents the URL to a different host.
  it.each([
    ["backslash prefix", "/\\evil.com"],
    ["double backslash", "/\\\\evil.com"],
    ["backslash+slash mix", "/\\/evil.com"],
    ["slash+backslash mix", "//\\evil.com"],
    ["tab smuggling", "/\tevil.com"],
    ["CR smuggling", "/\revil.com"],
    ["LF smuggling", "/\nevil.com"],
    ["percent-encoded backslash", "/%5c/evil.com"],
    ["percent-encoded slash", "/%2f/evil.com"],
    ["double-encoded slash", "/%252f/evil.com"],
    ["double-encoded backslash", "/%255c/evil.com"],
    ["user-info injection", "/@evil.com"],
    ["null byte", "/\x00evil.com"],
    ["leading whitespace", " //evil.com"],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeCallbackUrl(input)).toBe("/address-book");
  });
});
