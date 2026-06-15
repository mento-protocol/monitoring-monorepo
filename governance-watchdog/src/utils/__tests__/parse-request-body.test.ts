import { describe, expect, it } from "vitest";
import { EventType } from "../../events/types.js";
import healthCheck from "../../events/fixtures/health-check.fixture.json";
import proposalCreated from "../../events/fixtures/proposal-created.fixture.json";
import parseRequestBody from "../parse-request-body.js";

describe("parseRequestBody", () => {
  it.each([
    null,
    {},
    { result: "x" },
    { result: [{ name: "ProposalCreated" }] },
  ])("rejects invalid QuickNode payload %#", (payload) => {
    expect(() => parseRequestBody(payload)).toThrow(
      "Request body is not a valid QuickNode payload",
    );
  });

  it("returns valid events as-is", () => {
    const result = parseRequestBody(proposalCreated);

    expect(result).toEqual(proposalCreated.result);
  });

  it("skips unknown events while keeping supported events", () => {
    const result = parseRequestBody(healthCheck);

    expect(result).not.toHaveLength(0);
    expect(
      result.every((event) => event.name === EventType.MedianUpdated),
    ).toBe(true);
  });

  it("returns an empty list when every event is unknown", () => {
    const payload = {
      result: [
        {
          address: "0x0000000000000000000000000000000000000000",
          blockHash: "0xblock",
          blockNumber: "1",
          logIndex: "0",
          name: "OracleReported",
          transactionHash: "0xtx",
        },
      ],
    };

    expect(parseRequestBody(payload)).toEqual([]);
  });
});
