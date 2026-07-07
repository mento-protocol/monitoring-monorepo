import { describe, expect, it } from "vitest";
import {
  resourceHintOriginFromHasuraUrl,
  resourceHintOriginsFromHasuraUrls,
} from "@/components/resource-hints";

describe("resource hints", () => {
  it("derives unique HTTPS GraphQL origins from configured Hasura URLs", () => {
    expect(
      resourceHintOriginsFromHasuraUrls([
        "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql",
        "https://indexer.hyperindex.xyz/testnet/v1/graphql",
        "https://testnet.hyperindex.xyz/v1/graphql",
        undefined,
      ]),
    ).toEqual([
      "https://indexer.hyperindex.xyz",
      "https://testnet.hyperindex.xyz",
    ]);
  });

  it("skips relative proxies and local fixture endpoints", () => {
    expect(resourceHintOriginFromHasuraUrl("/api/hasura/celo-mainnet")).toBe(
      null,
    );
    expect(
      resourceHintOriginFromHasuraUrl("http://127.0.0.1:4011/graphql"),
    ).toBe(null);
    expect(
      resourceHintOriginFromHasuraUrl("https://localhost:4011/graphql"),
    ).toBe(null);
    expect(resourceHintOriginFromHasuraUrl("https://[::1]:4011/graphql")).toBe(
      null,
    );
  });
});
