import { describe, expect, it } from "vitest";
import { formatExecutionEvent } from "./execution-formatters";
import { formatModuleEvent } from "./module-formatters";
import {
  formatApproveHashEvent,
  formatFallbackHandlerEvent,
  formatGuardEvent,
  formatSignMsgEvent,
  formatThresholdEvent,
} from "./security-formatters";
import type { QuickNodeDecodedLog } from "../types";

function log(overrides: Partial<QuickNodeDecodedLog>): QuickNodeDecodedLog {
  return {
    address: "0x123",
    name: "AddedOwner",
    transactionHash: "0xtx",
    blockHash: "0xblock",
    blockNumber: "100",
    logIndex: "0",
    ...overrides,
  };
}

describe("execution event formatter", () => {
  it("formats string payment values using the chain decimals and symbol", async () => {
    await expect(
      formatExecutionEvent(log({ payment: "1234567" }), {
        decimals: 6,
        symbol: "CELO",
      }),
    ).resolves.toEqual([
      {
        name: "Payment",
        value: "1.234567 CELO",
        inline: false,
      },
    ]);
  });

  it("formats numeric payment values", async () => {
    await expect(
      formatExecutionEvent(log({ payment: 2_000_000 }), {
        decimals: 6,
        symbol: "CELO",
      }),
    ).resolves.toEqual([
      {
        name: "Payment",
        value: "2.000000 CELO",
        inline: false,
      },
    ]);
  });

  it("omits zero, missing, and unparsable payment values", async () => {
    const chainConfig = { decimals: 6, symbol: "CELO" };

    await expect(
      formatExecutionEvent(log({ payment: "0" }), chainConfig),
    ).resolves.toEqual([]);
    await expect(formatExecutionEvent(log({}), chainConfig)).resolves.toEqual(
      [],
    );
    await expect(
      formatExecutionEvent(log({ payment: "not-a-number" }), chainConfig),
    ).resolves.toEqual([]);
  });
});

describe("module event formatter", () => {
  it("formats enabled and disabled module addresses", async () => {
    await expect(
      formatModuleEvent(log({ name: "EnabledModule", module: "0xmodule" })),
    ).resolves.toEqual([
      {
        name: "Module",
        value: "0xmodule",
        inline: false,
      },
    ]);
  });

  it("omits missing and non-string module values", async () => {
    await expect(formatModuleEvent(log({}))).resolves.toEqual([]);
    await expect(formatModuleEvent(log({ module: 123 }))).resolves.toEqual([]);
  });
});

describe("security event formatters", () => {
  it("formats changed threshold values from strings and numbers", async () => {
    await expect(
      formatThresholdEvent(log({ name: "ChangedThreshold", threshold: "3" })),
    ).resolves.toEqual([
      {
        name: "New Threshold",
        value: "3",
        inline: false,
      },
    ]);

    await expect(
      formatThresholdEvent(log({ name: "ChangedThreshold", threshold: 4 })),
    ).resolves.toEqual([
      {
        name: "New Threshold",
        value: "4",
        inline: false,
      },
    ]);
  });

  it("omits changed threshold when no threshold is present", async () => {
    await expect(formatThresholdEvent(log({}))).resolves.toEqual([]);
  });

  it("formats fallback handler and guard addresses", async () => {
    await expect(
      formatFallbackHandlerEvent(
        log({ name: "ChangedFallbackHandler", handler: "0xhandler" }),
      ),
    ).resolves.toEqual([
      {
        name: "Fallback Handler",
        value: "0xhandler",
        inline: false,
      },
    ]);

    await expect(
      formatGuardEvent(log({ name: "ChangedGuard", guard: "0xguard" })),
    ).resolves.toEqual([
      {
        name: "Guard",
        value: "0xguard",
        inline: false,
      },
    ]);
  });

  it("omits fallback handler and guard fields for non-string values", async () => {
    await expect(
      formatFallbackHandlerEvent(log({ handler: 123 })),
    ).resolves.toEqual([]);
    await expect(formatGuardEvent(log({ guard: 123 }))).resolves.toEqual([]);
  });

  it("formats approved hash with the ABI field name and owner", async () => {
    await expect(
      formatApproveHashEvent(
        log({
          name: "ApproveHash",
          approvedHash: "0xapproved",
          hash: "0xlegacy",
          owner: "0xowner",
        }),
      ),
    ).resolves.toEqual([
      {
        name: "Hash",
        value: "0xapproved",
        inline: false,
      },
      {
        name: "Owner",
        value: "0xowner",
        inline: false,
      },
    ]);
  });

  it("falls back to legacy hash for approved hash events", async () => {
    await expect(
      formatApproveHashEvent(log({ name: "ApproveHash", hash: "0xlegacy" })),
    ).resolves.toEqual([
      {
        name: "Hash",
        value: "0xlegacy",
        inline: false,
      },
    ]);
  });

  it("formats signed message hashes", async () => {
    await expect(
      formatSignMsgEvent(log({ name: "SignMsg", msgHash: "0xmessage" })),
    ).resolves.toEqual([
      {
        name: "Message Hash",
        value: "0xmessage",
        inline: false,
      },
    ]);
  });

  it("omits approve-hash and sign-message fields for missing or non-string values", async () => {
    await expect(
      formatApproveHashEvent(log({ approvedHash: 123, owner: 456 })),
    ).resolves.toEqual([]);
    await expect(formatSignMsgEvent(log({ msgHash: 123 }))).resolves.toEqual(
      [],
    );
  });
});
