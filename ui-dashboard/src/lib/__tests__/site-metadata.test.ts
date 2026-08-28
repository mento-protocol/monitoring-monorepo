import { describe, expect, it } from "vitest";
import { PRODUCTION_SITE_ORIGIN, resolveMetadataBase } from "../site-metadata";

describe("resolveMetadataBase", () => {
  it("keeps localhost social images on the active development port", () => {
    const headers = new Headers({ host: "127.0.0.1:3210" });

    expect(resolveMetadataBase(headers).href).toBe("http://127.0.0.1:3210/");
  });

  it("uses the forwarded deployment origin behind Vercel", () => {
    const headers = new Headers({
      "x-forwarded-host": "monitoring-preview.vercel.app",
      "x-forwarded-proto": "https",
    });

    expect(resolveMetadataBase(headers).href).toBe(
      "https://monitoring-preview.vercel.app/",
    );
  });

  it("uses only the first proxy value", () => {
    const headers = new Headers({
      "x-forwarded-host": "monitoring.mento.org, internal-proxy",
      "x-forwarded-proto": "https, http",
    });

    expect(resolveMetadataBase(headers).href).toBe(
      "https://monitoring.mento.org/",
    );
  });

  it("falls back to the canonical production origin without a valid host", () => {
    expect(resolveMetadataBase(new Headers()).href).toBe(
      `${PRODUCTION_SITE_ORIGIN}/`,
    );
    expect(
      resolveMetadataBase(new Headers({ host: "https://bad host" })).href,
    ).toBe(`${PRODUCTION_SITE_ORIGIN}/`);
  });

  it("rejects valid but untrusted host headers", () => {
    expect(
      resolveMetadataBase(new Headers({ host: "attacker.example" })).href,
    ).toBe(`${PRODUCTION_SITE_ORIGIN}/`);
    expect(
      resolveMetadataBase(new Headers({ host: "preview.vercel.app.evil.test" }))
        .href,
    ).toBe(`${PRODUCTION_SITE_ORIGIN}/`);
  });
});
