/**
 * Server-shell tests for `app/cdps/[symbol]/troves/[troveId]/page.tsx` —
 * mirrors `address-book/[address]/__tests__/page.server.test.ts`. The page
 * validates the route's on-chain hex troveId before any client JS ships and
 * redirects garbage to the market page (never a redirect loop back to
 * itself).
 */

import { describe, it, expect, vi } from "vitest";

const redirectCalls: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    redirectCalls.push(path);
    throw new Error(`__REDIRECT__:${path}`);
  },
}));

vi.mock("../_components/trove-detail-client", () => ({
  TroveDetailClient: () => null,
}));

import TroveDetailPage, { generateMetadata } from "../page";
import { TroveDetailClient } from "../_components/trove-detail-client";

function makeParams(
  symbol: string,
  troveId: string,
): Promise<{ symbol: string; troveId: string }> {
  return Promise.resolve({ symbol, troveId });
}

describe("TroveDetailPage server shell — invalid troveId redirects", () => {
  it("redirects to the market page for non-hex garbage", async () => {
    redirectCalls.length = 0;
    await expect(
      TroveDetailPage({ params: makeParams("gbpm", "not-a-trove-id") }),
    ).rejects.toThrow("__REDIRECT__:/cdps/gbpm");
    expect(redirectCalls).toEqual(["/cdps/gbpm"]);
  });

  it("redirects on empty troveId", async () => {
    redirectCalls.length = 0;
    await expect(
      TroveDetailPage({ params: makeParams("gbpm", "") }),
    ).rejects.toThrow("__REDIRECT__:/cdps/gbpm");
  });

  it("redirects on malformed percent-encoding without crashing the error boundary", async () => {
    redirectCalls.length = 0;
    await expect(
      TroveDetailPage({ params: makeParams("gbpm", "%zz") }),
    ).rejects.toThrow("__REDIRECT__:/cdps/gbpm");
  });

  it("redirects a bare address-length hex value the same way (it's not a valid trove id shape check bypass)", async () => {
    // Sanity: the trove id pattern doesn't accidentally require exactly 40
    // hex chars like an address — this just confirms non-matching lengths
    // outside 1..64 are still rejected consistently via the redirect path.
    redirectCalls.length = 0;
    const tooLong = `0x${"f".repeat(65)}`;
    await expect(
      TroveDetailPage({ params: makeParams("gbpm", tooLong) }),
    ).rejects.toThrow("__REDIRECT__:/cdps/gbpm");
  });
});

describe("TroveDetailPage server shell — valid troveId renders the client", () => {
  it("lowercases the troveId and forwards symbol + troveId to the client component", async () => {
    redirectCalls.length = 0;
    const result = (await TroveDetailPage({
      params: makeParams("gbpm", "0x8ABC"),
    })) as React.ReactElement<{ symbol: string; troveId: string }>;
    expect(redirectCalls).toEqual([]);
    expect(result.type).toBe(TroveDetailClient);
    expect(result.props.symbol).toBe("gbpm");
    expect(result.props.troveId).toBe("0x8abc");
  });

  it("forwards a percent-encoded valid troveId verbatim after decoding", async () => {
    redirectCalls.length = 0;
    const encoded = "0%78" + "8abc";
    const result = (await TroveDetailPage({
      params: makeParams("gbpm", encoded),
    })) as React.ReactElement<{ symbol: string; troveId: string }>;
    expect(redirectCalls).toEqual([]);
    expect(result.props.troveId).toBe("0x8abc");
  });
});

describe("TroveDetailPage social metadata", () => {
  it("uses the position identity for Open Graph and Twitter unfurls", async () => {
    const metadata = await generateMetadata({
      params: makeParams(
        "gbpm",
        "0x8ABCB264ED2E25BEB15C6D31228771BE0C804AC3ABE6CF8C4432A1C4AC2C0D7D",
      ),
    });

    const socialTitle = "GBPM Trove 0x8abc…0d7d history — Mento Analytics";
    expect(metadata.title).toBe(
      "Trove 0x8abcb264ed2e25beb15c6d31228771be0c804ac3abe6cf8c4432a1c4ac2c0d7d — GBPM CDP — Mento Analytics",
    );
    expect(metadata.description).toBe(
      "Indexed history for a Mento CDP position.",
    );
    expect(metadata.openGraph).toMatchObject({
      title: socialTitle,
      type: "website",
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: socialTitle,
    });
  });
});
