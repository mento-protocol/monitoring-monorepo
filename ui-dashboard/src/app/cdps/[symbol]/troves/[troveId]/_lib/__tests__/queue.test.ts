import { describe, expect, it } from "vitest";
import { CDP_TROVES_DETAIL_LIMIT } from "../../../../../_lib/types";
import {
  buildTroveQueueModel,
  maxTroveQueueRungDebt,
  troveQueueBarWidthPercent,
  type CdpTroveQueueResponse,
  type TroveQueueReadyModel,
} from "../queue";

type CdpTroveQueueTroveRow = CdpTroveQueueResponse["OpenTrove"][number];

const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function rateWei(bps: number): string {
  return ((BigInt(bps) * D18) / BigInt(10_000)).toString();
}

function openTrove(
  overrides: Partial<CdpTroveQueueTroveRow> = {},
): CdpTroveQueueTroveRow {
  return {
    id: "gbpm-0x1",
    status: "active",
    debt: wei(1_000),
    interestRate: rateWei(100),
    interestBatchId: null,
    ...overrides,
  };
}

function response(
  overrides: Partial<CdpTroveQueueResponse> = {},
): CdpTroveQueueResponse {
  return {
    LiquityInstance: [{ id: "gbpm", isShutDown: false, shutDownAt: null }],
    OpenTrove: [openTrove()],
    InterestBatch: [],
    ...overrides,
  };
}

function ready(
  data: CdpTroveQueueResponse,
  troveEntityId: string,
): TroveQueueReadyModel {
  const model = buildTroveQueueModel(data, troveEntityId);
  expect(model.kind).toBe("ready");
  return model as TroveQueueReadyModel;
}

describe("buildTroveQueueModel", () => {
  it("ranks active troves by effective rate ascending with dense per-rate positions", () => {
    const model = ready(
      response({
        OpenTrove: [
          // Deliberately unsorted input — the model owns the ordering.
          openTrove({ id: "gbpm-0x3", interestRate: rateWei(160) }),
          openTrove({
            id: "gbpm-0x1",
            interestRate: rateWei(50),
            debt: wei(200),
          }),
          openTrove({
            id: "gbpm-0x2",
            interestRate: rateWei(50),
            debt: wei(300),
          }),
        ],
      }),
      "gbpm-0x3",
    );

    expect(model.rungs.map((r) => r.position)).toEqual([1, 2]);
    expect(model.rungs[0]).toMatchObject({
      rate: rateWei(50),
      debt: wei(500),
      troveCount: 2,
      containsThisTrove: false,
    });
    expect(model.rungs[1]).toMatchObject({
      rate: rateWei(160),
      debt: wei(1_000),
      troveCount: 1,
      containsThisTrove: true,
    });
    expect(model.thisTrove).toEqual({
      position: 2,
      rateLevels: 2,
      rate: rateWei(160),
      shieldDebt: wei(500),
    });
  });

  it("computes the shield from STRICTLY lower rates — same-rate debt shields nothing", () => {
    const model = ready(
      response({
        OpenTrove: [
          openTrove({
            id: "gbpm-0x1",
            interestRate: rateWei(50),
            debt: wei(200),
          }),
          openTrove({
            id: "gbpm-0x2",
            interestRate: rateWei(160),
            debt: wei(9_000),
          }),
          openTrove({
            id: "gbpm-0x3",
            interestRate: rateWei(160),
            debt: wei(1_000),
          }),
        ],
      }),
      "gbpm-0x3",
    );

    // Only the 0.50% rung's 200 shields — the 9,000 at the same 1.60% rate
    // does not.
    expect(model.thisTrove?.shieldDebt).toBe(wei(200));
    expect(model.thisTrove?.position).toBe(2);
  });

  it("reports a zero shield for the front of the queue", () => {
    const model = ready(response(), "gbpm-0x1");
    expect(model.thisTrove).toEqual({
      position: 1,
      rateLevels: 1,
      rate: rateWei(100),
      shieldDebt: "0",
    });
  });

  it("excludes zombies from rank AND shield — they sit outside the queue", () => {
    const model = ready(
      response({
        OpenTrove: [
          // A zombie at the lowest rate: if it leaked into the model it
          // would both claim position #1 and inflate the shield.
          openTrove({
            id: "gbpm-0xz",
            status: "zombie",
            interestRate: rateWei(20),
            debt: wei(50_000),
          }),
          openTrove({
            id: "gbpm-0x1",
            interestRate: rateWei(50),
            debt: wei(200),
          }),
          openTrove({ id: "gbpm-0x2", interestRate: rateWei(160) }),
        ],
      }),
      "gbpm-0x2",
    );

    expect(model.rungs).toHaveLength(2);
    expect(model.rungs[0]?.rate).toBe(rateWei(50));
    expect(model.thisTrove?.position).toBe(2);
    expect(model.thisTrove?.shieldDebt).toBe(wei(200));
  });

  it("holds no position for a zombie trove itself", () => {
    const model = ready(
      response({
        OpenTrove: [
          openTrove({ id: "gbpm-0x1" }),
          openTrove({ id: "gbpm-0xz", status: "zombie" }),
        ],
      }),
      "gbpm-0xz",
    );
    expect(model.thisTrove).toBeNull();
    expect(model.rungs).toHaveLength(1);
  });

  it("queues a batch-managed trove at the batch's CURRENT rate, not its stale copy", () => {
    const model = ready(
      response({
        OpenTrove: [
          openTrove({ id: "gbpm-0x1", interestRate: rateWei(50) }),
          openTrove({
            id: "gbpm-0x2",
            // Stale copied rate says 0.20% (would rank first) — the batch's
            // live rate is 2.50% (ranks last).
            interestRate: rateWei(20),
            interestBatchId: "batch-1",
          }),
        ],
        InterestBatch: [{ id: "batch-1", annualInterestRate: rateWei(250) }],
      }),
      "gbpm-0x2",
    );

    expect(model.thisTrove?.position).toBe(2);
    expect(model.thisTrove?.rate).toBe(rateWei(250));
  });

  it("suppresses rank and shield when an active trove's batch rate is unresolved", () => {
    const model = buildTroveQueueModel(
      response({
        OpenTrove: [
          openTrove({ id: "gbpm-0x1" }),
          openTrove({ id: "gbpm-0x2", interestBatchId: "batch-missing" }),
        ],
      }),
      "gbpm-0x1",
    );
    expect(model).toEqual({ kind: "unresolved-rates", unresolvedCount: 1 });
  });

  it("suppresses everything at the open-trove fetch cap — never a partial calculation", () => {
    const cappedRows = Array.from({ length: CDP_TROVES_DETAIL_LIMIT }, (_, i) =>
      openTrove({ id: `gbpm-0x${i.toString(16)}` }),
    );
    const model = buildTroveQueueModel(
      response({ OpenTrove: cappedRows }),
      "gbpm-0x1",
    );
    expect(model).toEqual({ kind: "capped" });

    // One row below the cap is a complete fetch — no suppression.
    const underCap = buildTroveQueueModel(
      response({ OpenTrove: cappedRows.slice(1) }),
      "gbpm-0x1",
    );
    expect(underCap.kind).toBe("ready");
  });

  it("replaces the ladder with the shutdown state while isShutDown is set — even over a capped fetch", () => {
    const cappedRows = Array.from({ length: CDP_TROVES_DETAIL_LIMIT }, (_, i) =>
      openTrove({ id: `gbpm-0x${i.toString(16)}` }),
    );
    const model = buildTroveQueueModel(
      response({
        LiquityInstance: [
          { id: "gbpm", isShutDown: true, shutDownAt: "1750000000" },
        ],
        OpenTrove: cappedRows,
      }),
      "gbpm-0x1",
    );
    expect(model).toEqual({ kind: "shutdown", shutDownAt: "1750000000" });
  });

  it("is empty with no active troves (zombies alone do not form a queue)", () => {
    const model = buildTroveQueueModel(
      response({
        OpenTrove: [openTrove({ id: "gbpm-0xz", status: "zombie" })],
      }),
      "gbpm-0xz",
    );
    expect(model).toEqual({ kind: "empty" });
  });

  it("returns a ladder without a position for a trove absent from the active set", () => {
    const model = ready(response(), "gbpm-0xclosed");
    expect(model.thisTrove).toBeNull();
    expect(model.rungs).toHaveLength(1);
  });

  it("normalizes rate strings so equal rates share one rung", () => {
    const model = ready(
      response({
        OpenTrove: [
          openTrove({ id: "gbpm-0x1", interestRate: "0" }),
          openTrove({ id: "gbpm-0x2", interestRate: "00" }),
        ],
      }),
      "gbpm-0x1",
    );
    expect(model.rungs).toHaveLength(1);
    expect(model.rungs[0]?.troveCount).toBe(2);
  });

  it("withholds the ladder when the LiquityInstance row is missing — the shutdown flag is unknown, never defaulted to healthy", () => {
    const model = buildTroveQueueModel(
      response({ LiquityInstance: [] }),
      "gbpm-0x1",
    );
    expect(model).toEqual({ kind: "instance-missing" });
  });
});

describe("bar proportions", () => {
  it("computes widths proportional to the largest rung", () => {
    expect(
      maxTroveQueueRungDebt([{ debt: wei(200) }, { debt: wei(800) }]),
    ).toBe(wei(800));
    expect(troveQueueBarWidthPercent(wei(200), wei(800))).toBe("25.0%");
    expect(troveQueueBarWidthPercent(wei(800), wei(800))).toBe("100.0%");
    expect(troveQueueBarWidthPercent("0", wei(800))).toBe("0.0%");
  });

  it("degrades to 0% instead of dividing by a zero maximum", () => {
    expect(troveQueueBarWidthPercent("0", "0")).toBe("0%");
    expect(maxTroveQueueRungDebt([])).toBe("0");
  });
});
