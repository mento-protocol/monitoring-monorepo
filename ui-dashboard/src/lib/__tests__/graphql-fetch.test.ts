import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientError,
  getGraphQLClient,
  GraphQLClient,
} from "@/lib/graphql-fetch";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GraphQLClient", () => {
  it("posts a positional query and returns its data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { Pool: [{ id: "pool-1" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GraphQLClient("https://example.com/graphql");
    await expect(
      client.request("query Pools($limit: Int!) { Pool { id } }", {
        limit: 10,
      }),
    ).resolves.toEqual({ Pool: [{ id: "pool-1" }] });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query Pools($limit: Int!) { Pool { id } }",
        variables: { limit: 10 },
      }),
    });
  });

  it("supports object-form requests and forwards AbortSignal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { __typename: "query_root" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const client = new GraphQLClient("https://example.com/graphql");

    await client.request({
      document: "query TypeName { __typename }",
      variables: { include: true },
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/graphql",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("throws ClientError for GraphQL errors on a successful HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: null,
          errors: [{ message: "field failed", path: ["Pool"] }],
        }),
      ),
    );
    const client = new GraphQLClient("https://example.com/graphql");

    const error = await client
      .request("query Pools { Pool { id } }")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      response: {
        status: 200,
        errors: [{ message: "field failed", path: ["Pool"] }],
      },
    });
  });

  it("throws ClientError rather than TypeError for malformed errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: "not-an-array" })),
    );
    const client = new GraphQLClient("https://example.com/graphql");

    await expect(
      client.request("query Pools { Pool { id } }"),
    ).rejects.toMatchObject({
      name: "ClientError",
      response: { status: 200 },
    });
  });

  it("preserves status, headers, and body on non-2xx errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Tier quota exceeded", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      ),
    );
    const client = new GraphQLClient("https://example.com/graphql");

    const error = await client
      .request("query Pools { Pool { id } }")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).response.status).toBe(429);
    expect((error as ClientError).response.headers.get("retry-after")).toBe(
      "120",
    );
    expect((error as ClientError).response.body).toBe("Tier quota exceeded");
  });

  it("propagates fetch aborts without wrapping them", async () => {
    const abortError = new DOMException(
      "This operation was aborted",
      "AbortError",
    );
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = new GraphQLClient("https://example.com/graphql").request({
      document: "query TypeName { __typename }",
      signal: controller.signal,
    });

    controller.abort();
    await expect(request).rejects.toBe(abortError);
  });
});

describe("getGraphQLClient", () => {
  it("reuses clients per endpoint without sharing across endpoints", () => {
    const first = getGraphQLClient("https://one.example/graphql");
    expect(getGraphQLClient("https://one.example/graphql")).toBe(first);
    expect(getGraphQLClient("https://two.example/graphql")).not.toBe(first);
  });
});
