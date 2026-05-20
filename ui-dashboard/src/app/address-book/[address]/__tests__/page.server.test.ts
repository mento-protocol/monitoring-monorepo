/**
 * Server-shell tests for `app/address-book/[address]/page.tsx`. The
 * page is now an async server component that validates `params.address`
 * (decode + lowercase + `isValidAddress`) and calls `redirect("/address-book")`
 * for malformed / garbage input before any client JS ships.
 *
 * These tests cover the branches the prior client-side `useEffect +
 * router.replace` flow used to test (deleted from `page.test.tsx` when
 * the redirect moved server-side). Cursor flagged the coverage gap on
 * PR #371 — re-homed here.
 */

import { describe, it, expect, vi } from "vitest";

// `redirect()` from `next/navigation` throws a `NEXT_REDIRECT` error
// internally; we mock it to a regular `Error` we can assert against and
// capture the destination.
const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    redirectCalls.push(path);
    throw new Error(`__REDIRECT__:${path}`);
  },
}));

// Stub the metadata helper — invalid-address tests don't exercise it,
// and importing it would pull in the Redis client.
vi.mock("../_lib/og-metadata", () => ({
  buildAddressOgMetadata: vi.fn(),
}));

// Stub the client component so tests don't drag in the full
// AddressLabelsProvider / SWR / etc.
vi.mock("../_components/address-detail-page-client", () => ({
  AddressDetailPageClient: () => null,
}));

import AddressDetailPage from "../page";
import { AddressDetailPageClient } from "../_components/address-detail-page-client";

const VALID_ADDR = "0x" + "a".repeat(40);

function makeParams(raw: string): Promise<{ address: string }> {
  return Promise.resolve({ address: raw });
}

describe("AddressDetailPage server shell — invalid input redirects", () => {
  it("redirects to /address-book for non-hex garbage", async () => {
    redirectCalls.length = 0;
    await expect(
      AddressDetailPage({ params: makeParams("not-an-address") }),
    ).rejects.toThrow("__REDIRECT__:/address-book");
    expect(redirectCalls).toEqual(["/address-book"]);
  });

  it("redirects on malformed percent-encoding (e.g. /%zz) without crashing the error boundary", async () => {
    // Cursor flagged that an unguarded `decodeURIComponent` would throw
    // `URIError` and dump the user into the error boundary. The shell's
    // try-catch fallback in `decodeAddressParam` keeps the path silent:
    // raw "%zz" lowercases to "%zz" (still invalid), `isValidAddress`
    // returns false, `redirect()` runs.
    redirectCalls.length = 0;
    await expect(
      AddressDetailPage({ params: makeParams("%zz") }),
    ).rejects.toThrow("__REDIRECT__:/address-book");
    expect(redirectCalls).toEqual(["/address-book"]);
  });

  it("redirects on empty address", async () => {
    redirectCalls.length = 0;
    await expect(AddressDetailPage({ params: makeParams("") })).rejects.toThrow(
      "__REDIRECT__:/address-book",
    );
    expect(redirectCalls).toEqual(["/address-book"]);
  });
});

describe("AddressDetailPage server shell — valid input renders the client", () => {
  it("decodes + lowercases the param and forwards it to the client component", async () => {
    redirectCalls.length = 0;
    // Pass an upper-case address to confirm normalization happens here
    // (the client now expects pre-lowercased input — see the client
    // component's contract test in `page.test.tsx`).
    const upper = "0x" + "A".repeat(40);
    const result = (await AddressDetailPage({
      params: makeParams(upper),
    })) as React.ReactElement<{ address: string }>;
    expect(redirectCalls).toEqual([]);
    expect(result.type).toBe(AddressDetailPageClient);
    expect(result.props.address).toBe(upper.toLowerCase());
  });

  it("forwards a percent-encoded valid address verbatim after decoding", async () => {
    redirectCalls.length = 0;
    // Some routers double-encode the path on certain navigations; the
    // shell's `decodeURIComponent` should handle it transparently.
    const encoded = `0%78${"a".repeat(40)}`;
    const result = (await AddressDetailPage({
      params: makeParams(encoded),
    })) as React.ReactElement<{ address: string }>;
    expect(redirectCalls).toEqual([]);
    expect(result.type).toBe(AddressDetailPageClient);
    expect(result.props.address).toBe(VALID_ADDR);
  });
});
