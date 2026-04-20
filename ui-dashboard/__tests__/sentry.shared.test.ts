import { describe, it, expect } from "vitest";
import { stripAuthHeaders } from "../sentry.shared";

// Minimal test harness: stripAuthHeaders takes an ErrorEvent | TransactionEvent
// and mutates/returns it. For unit-test purposes we can cast a loose object to
// the relevant shape — the scrubber only reads fields by optional path.
function scrub<T extends object>(event: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stripAuthHeaders(event as any) as T;
}

describe("stripAuthHeaders — request headers", () => {
  it("removes cookie + Cookie + authorization + Authorization", () => {
    const event = {
      request: {
        headers: {
          "user-agent": "chrome",
          cookie: "session=abc",
          Cookie: "token=xyz",
          authorization: "Bearer 123",
          Authorization: "Bearer 456",
          "x-forwarded-for": "1.2.3.4",
        },
      },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.request.headers).toEqual({
      "user-agent": "chrome",
      "x-forwarded-for": "1.2.3.4",
    });
  });

  it("is a no-op when request.headers is absent", () => {
    const event = { request: { url: "https://example.com/x" } };
    const scrubbed = scrub(event);
    expect(scrubbed).toEqual({ request: { url: "https://example.com/x" } });
  });
});

describe("stripAuthHeaders — request.url redaction", () => {
  it("strips query string on request.url", () => {
    const event = {
      request: {
        url: "https://app.example.com/api/auth/callback?code=abc&state=xyz",
      },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.request.url).toBe(
      "https://app.example.com/api/auth/callback",
    );
  });

  it("strips userinfo (user:pass@) on request.url", () => {
    const event = {
      request: { url: "https://user:pass@api.example.com/v1/graphql" },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.request.url).toBe("https://api.example.com/v1/graphql");
  });

  it("clears fragment on request.url", () => {
    const event = {
      request: { url: "https://app.example.com/path#secret-anchor" },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.request.url).toBe("https://app.example.com/path");
  });

  it("preserves scheme + host + path on request.url", () => {
    const event = { request: { url: "https://app.example.com/api/pools" } };
    const scrubbed = scrub(event);
    expect(scrubbed.request.url).toBe("https://app.example.com/api/pools");
  });

  it("leaves malformed URLs alone", () => {
    const event = { request: { url: "not-a-url" } };
    const scrubbed = scrub(event);
    expect(scrubbed.request.url).toBe("not-a-url");
  });
});

describe("stripAuthHeaders — exception value redaction", () => {
  it("redacts URL query + userinfo in every exception.values[].value", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value:
              "fetch failed https://user:pass@celo-mainnet.infura.io/v3/xyz?extra=1",
          },
          {
            type: "Error",
            value:
              "second frame mentions https://api.example.com/pools?limit=10",
          },
        ],
      },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.exception.values[0].value).toBe(
      "fetch failed https://celo-mainnet.infura.io/v3/xyz",
    );
    expect(scrubbed.exception.values[1].value).toBe(
      "second frame mentions https://api.example.com/pools",
    );
  });

  it("is a no-op for exception values without URLs", () => {
    const event = {
      exception: { values: [{ type: "Error", value: "plain message" }] },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.exception.values[0].value).toBe("plain message");
  });
});

describe("stripAuthHeaders — breadcrumb redaction", () => {
  it("redacts URLs in breadcrumb.message and breadcrumb.data.url", () => {
    const event = {
      breadcrumbs: [
        {
          category: "fetch",
          message: "GET https://api.example.com/feed?token=secret — 200",
          data: { url: "https://api.example.com/feed?token=secret" },
        },
      ],
    };
    const scrubbed = scrub(event);
    expect(scrubbed.breadcrumbs[0].message).toBe(
      "GET https://api.example.com/feed — 200",
    );
    expect(scrubbed.breadcrumbs[0].data.url).toBe(
      "https://api.example.com/feed",
    );
  });
});
