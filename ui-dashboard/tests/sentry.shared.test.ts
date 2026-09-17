import { describe, it, expect } from "vitest";
import { eventFiltersIntegration } from "@sentry/nextjs";
import {
  EXTENSION_SCRIPT_DENY_URLS,
  filterAndStripSentryEvent,
  resolveTracesSampleRate,
  shouldEnableSentry,
  stripAuthHeaders,
} from "../sentry.shared";

describe("resolveTracesSampleRate", () => {
  it("samples 20% of production traces", () => {
    expect(resolveTracesSampleRate("production")).toBe(0.2);
  });

  it.each(["preview", "development", undefined])(
    "disables tracing when VERCEL_ENV is %s",
    (vercelEnv) => {
      expect(resolveTracesSampleRate(vercelEnv)).toBe(0);
    },
  );
});

// Run the real EventFilters integration over the deny list the browser client
// passes to Sentry.init, so the test covers the SDK's own matching instead of
// a copy of it. Stack frames are ordered oldest first, so the last frame is the
// one Sentry matches against denyUrls.
function filterExtensionNoise<T extends object>(event: T): T | null {
  const filters = eventFiltersIntegration({
    denyUrls: EXTENSION_SCRIPT_DENY_URLS,
  });
  const { processEvent } = filters;
  if (!processEvent) throw new Error("EventFilters lost its processEvent hook");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { getOptions: () => ({}) } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return processEvent(event as any, {}, client) as T | null;
}

const WALLET_EXTENSION_MESSAGE =
  "MetaMask: Lost connection to the extension provider.";

function eventWithFrames(filenames: string[]) {
  return {
    exception: {
      values: [
        {
          type: "Error",
          value: WALLET_EXTENSION_MESSAGE,
          stacktrace: { frames: filenames.map((filename) => ({ filename })) },
        },
      ],
    },
  };
}

const INPAGE_SCRIPT =
  "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js";

describe("EXTENSION_SCRIPT_DENY_URLS", () => {
  it("drops an event whose frames all come from an injected extension script", () => {
    expect(
      filterExtensionNoise(eventWithFrames([INPAGE_SCRIPT, INPAGE_SCRIPT])),
    ).toBeNull();
  });

  it("keeps an event with a first-party frame carrying the same message", () => {
    const event = eventWithFrames([
      INPAGE_SCRIPT,
      "https://monitoring.mento.org/_next/static/chunks/app/page.js",
    ]);
    expect(filterExtensionNoise(event)).toBe(event);
  });

  it.each(["moz-extension://abc/inpage.js", "safari-web-extension://abc/x.js"])(
    "drops injected-script noise from %s",
    (filename) => {
      expect(filterExtensionNoise(eventWithFrames([filename]))).toBeNull();
    },
  );
});

// Minimal test harness: stripAuthHeaders takes an ErrorEvent | TransactionEvent
// and mutates/returns it. For unit-test purposes we can cast a loose object to
// the relevant shape — the scrubber only reads fields by optional path.
function scrub<T extends object>(event: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stripAuthHeaders(event as any) as T;
}

function filter<T extends object>(event: T): T | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return filterAndStripSentryEvent(event as any) as T | null;
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
    expect(scrubbed.exception.values[0]!.value).toBe(
      "fetch failed https://celo-mainnet.infura.io/v3/xyz",
    );
    expect(scrubbed.exception.values[1]!.value).toBe(
      "second frame mentions https://api.example.com/pools",
    );
  });

  it("is a no-op for exception values without URLs", () => {
    const event = {
      exception: { values: [{ type: "Error", value: "plain message" }] },
    };
    const scrubbed = scrub(event);
    expect(scrubbed.exception.values[0]!.value).toBe("plain message");
  });
});

describe("shouldEnableSentry", () => {
  it("returns false when VERCEL_ENV is undefined (localhost)", () => {
    expect(shouldEnableSentry(undefined)).toBe(false);
  });

  it("returns false when VERCEL_ENV is empty string", () => {
    expect(shouldEnableSentry("")).toBe(false);
  });

  it("returns true on Vercel production", () => {
    expect(shouldEnableSentry("production")).toBe(true);
  });

  it("returns true on Vercel preview", () => {
    expect(shouldEnableSentry("preview")).toBe(true);
  });

  it("returns true on Vercel development (vercel dev)", () => {
    expect(shouldEnableSentry("development")).toBe(true);
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
    expect(scrubbed.breadcrumbs[0]!.message).toBe(
      "GET https://api.example.com/feed — 200",
    );
    expect(scrubbed.breadcrumbs[0]!.data.url).toBe(
      "https://api.example.com/feed",
    );
  });
});

describe("filterAndStripSentryEvent — loopback requests", () => {
  it("drops localhost request URLs", () => {
    expect(
      filter({ request: { url: "http://localhost:3000/api/pools" } }),
    ).toBeNull();
  });

  it("drops 127.0.0.1 request URLs", () => {
    expect(
      filter({ request: { url: "http://127.0.0.1:3000/api/pools" } }),
    ).toBeNull();
  });

  it("drops other 127.0.0.0/8 request URLs", () => {
    expect(
      filter({ request: { url: "http://127.0.0.2:3000/api/pools" } }),
    ).toBeNull();
  });

  it("drops IPv6 loopback request URLs", () => {
    expect(
      filter({ request: { url: "http://[::1]:3000/api/pools" } }),
    ).toBeNull();
  });

  it("drops full-form IPv6 loopback request URLs", () => {
    expect(
      filter({
        request: { url: "http://[0:0:0:0:0:0:0:1]:3000/api/pools" },
      }),
    ).toBeNull();
  });

  it("drops localhost subdomain request URLs", () => {
    expect(
      filter({ request: { url: "http://preview.localhost:3000/api/pools" } }),
    ).toBeNull();
  });

  it("drops relative request URLs when the host header is loopback", () => {
    expect(
      filter({
        request: {
          url: "/api/pools",
          headers: { host: "127.0.0.1:3000" },
        },
      }),
    ).toBeNull();
  });

  it("drops relative request URLs when the forwarded host header is loopback", () => {
    expect(
      filter({
        request: {
          url: "/api/pools",
          headers: { "x-forwarded-host": "preview.localhost:3000" },
        },
      }),
    ).toBeNull();
  });

  it("drops events with a loopback Origin header", () => {
    expect(
      filter({
        request: {
          url: "https://monitoring.mento.org/api/pools",
          headers: { Origin: "http://127.0.0.1:3000" },
        },
      }),
    ).toBeNull();
  });

  it("drops events with a loopback Referer header", () => {
    expect(
      filter({
        request: {
          url: "https://monitoring.mento.org/api/pools",
          headers: { Referer: "http://localhost:3000/pools?debug=1" },
        },
      }),
    ).toBeNull();
  });

  it("keeps public request URLs and still strips auth data", () => {
    const filtered = filter({
      request: {
        url: "https://monitoring.mento.org/api/auth/callback?code=abc",
        headers: { cookie: "session=abc", host: "monitoring.mento.org" },
      },
    });

    expect(filtered).toEqual({
      request: {
        url: "https://monitoring.mento.org/api/auth/callback",
        headers: { host: "monitoring.mento.org" },
      },
    });
  });
});
