import { describe, it, expect } from "vitest";
import { buildSignInHref } from "@/components/auth-status";

// Unit tests for `buildSignInHref`, the helper that powers the live href
// (from `useLiveLocation`) on the global "Sign in" link.
//
// The two risky behaviors are:
//   (a) feeding the live browser location into the helper — exercised here via
//       the "live URL composition" cases. If the helper round-trips a
//       representative path+search correctly, the anchor href does too.
//   (b) the `/sign-in` self-link branch — exercised directly.

describe("buildSignInHref — non-sign-in path (default branch)", () => {
  it("encodes a bare pathname as callbackUrl", () => {
    expect(buildSignInHref("/leaderboard", "")).toBe(
      "/sign-in?callbackUrl=%2Fleaderboard",
    );
  });

  it("preserves the search string in the encoded callback", () => {
    expect(buildSignInHref("/bridge-flows", "?network=celo")).toBe(
      "/sign-in?callbackUrl=%2Fbridge-flows%3Fnetwork%3Dcelo",
    );
  });

  it("round-trips a sort+dir search via the live-URL composition path", () => {
    // This is what AuthStatus does with `useLiveLocation()`:
    //   buildSignInHref(liveLocation.pathname, liveLocation.search)
    // Simulating a /pools page that wrote `?poolsSort=tvl&poolsDir=desc` via
    // `window.history.replaceState` (see lib/use-table-sort.ts). The render-
    // time `useSearchParams()` snapshot would miss this; the live-URL path
    // captures it.
    expect(buildSignInHref("/pools", "?poolsSort=tvl&poolsDir=desc")).toBe(
      "/sign-in?callbackUrl=%2Fpools%3FpoolsSort%3Dtvl%26poolsDir%3Ddesc",
    );
  });

  it("falls back to '/' when pathname is an empty string", () => {
    expect(buildSignInHref("", "")).toBe("/sign-in?callbackUrl=%2F");
  });
});

describe("buildSignInHref — /sign-in self-link branch", () => {
  it("returns /sign-in unchanged when pathname is /sign-in with no search", () => {
    // No nesting, no callbackUrl wrap.
    expect(buildSignInHref("/sign-in", "")).toBe("/sign-in");
  });

  it("preserves an existing callbackUrl on /sign-in instead of re-wrapping", () => {
    // The naive wrap-and-encode path would produce
    // `/sign-in?callbackUrl=%2Fsign-in%3FcallbackUrl%3D%252Fpools`, which the
    // sanitizer collapses to `/`, silently dropping the original target.
    // The self-link branch returns the existing query verbatim.
    expect(buildSignInHref("/sign-in", "?callbackUrl=%2Fpools")).toBe(
      "/sign-in?callbackUrl=%2Fpools",
    );
  });

  it("preserves an arbitrary multi-param search on /sign-in", () => {
    expect(buildSignInHref("/sign-in", "?error=AccessDenied&foo=bar")).toBe(
      "/sign-in?error=AccessDenied&foo=bar",
    );
  });
});
