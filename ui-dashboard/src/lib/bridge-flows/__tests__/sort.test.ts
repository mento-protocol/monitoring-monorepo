import { describe, it, expect } from "vitest";
import { sortTransfers, compareNullable } from "../sort";
import type { OracleRateMap } from "@/lib/tokens";
import { makeTransfer as mk } from "./fixtures";

const noRates: OracleRateMap = new Map();

describe("compareNullable", () => {
  it("sinks nulls on ascending", () => {
    expect(compareNullable(null, 5, (x, y) => x - y, "asc")).toBe(1);
    expect(compareNullable(5, null, (x, y) => x - y, "asc")).toBe(-1);
  });

  it("sinks nulls on descending too (null always sinks)", () => {
    expect(compareNullable(null, 5, (x, y) => x - y, "desc")).toBe(1);
    expect(compareNullable(5, null, (x, y) => x - y, "desc")).toBe(-1);
  });

  it("returns 0 for both-null", () => {
    // Explicit <number> — with both args null/undefined TS can't infer T from
    // the arguments, so the comparator's x/y drift to possibly-null.
    expect(
      compareNullable<number>(null, undefined, (x, y) => x - y, "asc"),
    ).toBe(0);
  });

  it("ascending sorts smaller first", () => {
    expect(compareNullable(1, 2, (x, y) => x - y, "asc")).toBeLessThan(0);
  });

  it("descending sorts larger first", () => {
    expect(compareNullable(1, 2, (x, y) => x - y, "desc")).toBeGreaterThan(0);
  });
});

describe("sortTransfers — time branch", () => {
  it("desc default puts newest (biggest timestamp) first", () => {
    const a = mk({ id: "a", sentTimestamp: "1000" });
    const b = mk({ id: "b", sentTimestamp: "2000" });
    const c = mk({ id: "c", sentTimestamp: "500" });
    const out = sortTransfers([a, b, c], "time", "desc", noRates);
    expect(out.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("asc puts oldest first", () => {
    const a = mk({ id: "a", sentTimestamp: "1000" });
    const b = mk({ id: "b", sentTimestamp: "2000" });
    const out = sortTransfers([a, b], "time", "asc", noRates);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("falls back to firstSeenAt when sentTimestamp is null (dest-first race)", () => {
    const a = mk({ id: "a", sentTimestamp: null, firstSeenAt: "5000" });
    const b = mk({ id: "b", sentTimestamp: "3000", firstSeenAt: "0" });
    const out = sortTransfers([a, b], "time", "desc", noRates);
    expect(out[0].id).toBe("a"); // firstSeenAt 5000 > sentTimestamp 3000
  });
});

describe("sortTransfers — route branch", () => {
  it("sorts numerically on (sourceChainId, destChainId) — not lexically", () => {
    // Lexical sort would put "143-42220" < "42220-143" because "1" < "4".
    // Numeric must do the opposite: 143 < 42220.
    const monadToCelo = mk({
      id: "mono",
      sourceChainId: 143,
      destChainId: 42220,
    });
    const celoToMonad = mk({
      id: "celo",
      sourceChainId: 42220,
      destChainId: 143,
    });
    const asc = sortTransfers(
      [celoToMonad, monadToCelo],
      "route",
      "asc",
      noRates,
    );
    expect(asc.map((t) => t.id)).toEqual(["mono", "celo"]);
  });

  it("sinks unknown chain IDs on ascending (null → Infinity)", () => {
    const known = mk({ id: "k", sourceChainId: 42220, destChainId: 143 });
    const unknown = mk({ id: "u", sourceChainId: null, destChainId: null });
    const asc = sortTransfers([unknown, known], "route", "asc", noRates);
    expect(asc[0].id).toBe("k");
  });
});

describe("sortTransfers — amount branches", () => {
  it("amount desc sorts by token amount", () => {
    const big = mk({
      id: "big",
      amount: "10000000000000000000",
      tokenDecimals: 18,
    });
    const small = mk({
      id: "small",
      amount: "1000000000000000000",
      tokenDecimals: 18,
    });
    const out = sortTransfers([small, big], "amount", "desc", noRates);
    expect(out[0].id).toBe("big");
  });

  it("amount null rows sink", () => {
    const sized = mk({
      id: "sized",
      amount: "1000000000000000000",
      tokenDecimals: 18,
    });
    const empty = mk({ id: "empty", amount: null });
    const asc = sortTransfers([empty, sized], "amount", "asc", noRates);
    expect(asc[0].id).toBe("sized"); // null sinks
  });
});

describe("sortTransfers — amountUsd branches", () => {
  it("prefers indexer-pinned usdValueAtSend over live rate", () => {
    const pinned = mk({
      id: "pinned",
      tokenSymbol: "USDm",
      amount: "1000000000000000000",
      tokenDecimals: 18,
      usdValueAtSend: "9999.00",
    });
    const live = mk({
      id: "live",
      tokenSymbol: "USDm",
      amount: "5000000000000000000",
      tokenDecimals: 18,
    });
    // USDm is 1:1 USD via the usd-pegged set; live → 5. pinned → 9999.
    const desc = sortTransfers([live, pinned], "amountUsd", "desc", noRates);
    expect(desc[0].id).toBe("pinned");
  });
});

describe("sortTransfers — duration branch", () => {
  it("sorts by delivered - sent elapsed time", () => {
    const fast = mk({
      id: "fast",
      sentTimestamp: "1000",
      deliveredTimestamp: "1010",
      status: "DELIVERED",
    });
    const slow = mk({
      id: "slow",
      sentTimestamp: "1000",
      deliveredTimestamp: "2000",
      status: "DELIVERED",
    });
    const desc = sortTransfers([fast, slow], "duration", "desc", noRates);
    expect(desc.map((t) => t.id)).toEqual(["slow", "fast"]);
  });

  it("pending rows (no deliveredTimestamp) sink regardless of direction", () => {
    const delivered = mk({
      id: "d",
      sentTimestamp: "1000",
      deliveredTimestamp: "1100",
      status: "DELIVERED",
    });
    const pending = mk({
      id: "p",
      sentTimestamp: "1000",
      deliveredTimestamp: null,
      status: "SENT",
    });
    const asc = sortTransfers([pending, delivered], "duration", "asc", noRates);
    expect(asc[0].id).toBe("d");
    // Null sinks on desc too — without this, a page of duration-desc
    // sorted rows could start with a block of "pending" cells on top,
    // which is the opposite of the "no-data rows sink" UX contract.
    const desc = sortTransfers(
      [delivered, pending],
      "duration",
      "desc",
      noRates,
    );
    expect(desc[0].id).toBe("d");
    expect(desc[1].id).toBe("p");
  });
});

describe("sortTransfers — string branches sink empty values", () => {
  it("empty senders sink on ascending", () => {
    const named = mk({ id: "named", sender: "0xaaa" });
    const empty = mk({ id: "empty", sender: null });
    const asc = sortTransfers([empty, named], "sender", "asc", noRates);
    expect(asc[0].id).toBe("named");
  });

  it("sorts by status lexically", () => {
    const delivered = mk({ id: "d", deliveredBlock: "1", status: "DELIVERED" });
    const pending = mk({ id: "p", status: "PENDING" });
    const out = sortTransfers([pending, delivered], "status", "asc", noRates);
    // deriveBridgeStatus(delivered) === "DELIVERED" < "PENDING" lex
    expect(out[0].id).toBe("d");
  });
});
