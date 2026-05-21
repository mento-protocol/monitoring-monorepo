/**
 * Unit tests for owner event formatters
 */

import { describe, expect, it } from "vitest";
import { formatOwnerEvent } from "./owner-formatters";
import type { QuickNodeDecodedLog } from "../types";

describe("formatOwnerEvent", () => {
  it("should format AddedOwner event with owner address", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "AddedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
      owner: "0xowner123",
    };

    const fields = await formatOwnerEvent(log);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      name: "Owner",
      value: "0xowner123",
      inline: false,
    });
  });

  it("should format RemovedOwner event with owner address", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "RemovedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
      owner: "0xowner456",
    };

    const fields = await formatOwnerEvent(log);

    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe("0xowner456");
  });

  it("should return empty array if owner is missing", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "AddedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
    };

    const fields = await formatOwnerEvent(log);

    expect(fields).toHaveLength(0);
  });

  it("should return empty array if owner is not a string", async () => {
    const log: QuickNodeDecodedLog = {
      address: "0x123",
      name: "AddedOwner",
      transactionHash: "0xtx1",
      blockHash: "0xblock1",
      blockNumber: "100",
      logIndex: "0",
      owner: 12345, // Not a string
    };

    const fields = await formatOwnerEvent(log);

    expect(fields).toHaveLength(0);
  });
});
