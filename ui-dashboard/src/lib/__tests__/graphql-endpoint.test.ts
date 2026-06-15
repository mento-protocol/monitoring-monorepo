/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { resolveGraphqlEndpoint } from "../graphql-endpoint";

describe("resolveGraphqlEndpoint", () => {
  it("keeps hosted GraphQL URLs unchanged", () => {
    expect(resolveGraphqlEndpoint("https://hasura.example/v1/graphql")).toBe(
      "https://hasura.example/v1/graphql",
    );
  });

  it("resolves local proxy routes against the browser origin", () => {
    expect(resolveGraphqlEndpoint("/api/hasura/celo-sepolia-local")).toBe(
      new URL(
        "/api/hasura/celo-sepolia-local",
        window.location.origin,
      ).toString(),
    );
  });
});
