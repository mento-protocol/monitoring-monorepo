import type { Request } from "@google-cloud/functions-framework";
import { describe, expect, it } from "vitest";
import { checkPayloadSize } from "./check-payload-size";

const MAX_PAYLOAD_SIZE_BYTES = 10 * 1024 * 1024;

function request(body: unknown, rawBody?: Buffer): Request {
  return {
    body,
    rawBody,
  } as Request & { rawBody?: Buffer };
}

describe("checkPayloadSize", () => {
  it("accepts a raw body exactly at the configured limit", () => {
    const result = checkPayloadSize(
      request({}, Buffer.alloc(MAX_PAYLOAD_SIZE_BYTES)),
    );

    expect(result).toEqual({
      valid: true,
      size: MAX_PAYLOAD_SIZE_BYTES,
      maxSize: MAX_PAYLOAD_SIZE_BYTES,
    });
  });

  it("rejects a raw body one byte over the configured limit", () => {
    const result = checkPayloadSize(
      request({}, Buffer.alloc(MAX_PAYLOAD_SIZE_BYTES + 1)),
    );

    expect(result).toEqual({
      valid: false,
      size: MAX_PAYLOAD_SIZE_BYTES + 1,
      maxSize: MAX_PAYLOAD_SIZE_BYTES,
    });
  });

  it("uses rawBody size when the parsed body differs", () => {
    const result = checkPayloadSize(
      request({ parsed: "body" }, Buffer.from("raw")),
    );

    expect(result.size).toBe(3);
    expect(result.valid).toBe(true);
  });

  it("counts UTF-8 bytes for string bodies without rawBody", () => {
    const result = checkPayloadSize(request("€"));

    expect(result.size).toBe(3);
    expect(result.valid).toBe(true);
  });

  it("falls back to JSON byte length for parsed object bodies", () => {
    const body = { result: [{ name: "AddedOwner" }] };

    const result = checkPayloadSize(request(body));

    expect(result.size).toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
    expect(result.valid).toBe(true);
  });

  it("treats an absent body as an empty payload", () => {
    const result = checkPayloadSize(request(undefined));

    expect(result).toEqual({
      valid: true,
      size: 0,
      maxSize: MAX_PAYLOAD_SIZE_BYTES,
    });
  });
});
