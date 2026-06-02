import { describe, expect, it } from "vitest";
import { forwardFillSeries, zeroFillSeries } from "../chart-gap-fill";

const DAY = 86_400;

describe("forwardFillSeries", () => {
  it("returns undefined before the first stock observation and carries the latest value through gaps", () => {
    const series = forwardFillSeries(
      [
        { timestamp: DAY, value: 10 },
        { timestamp: 3 * DAY, value: 30 },
      ],
      { from: 0, to: 5 * DAY, bucketSeconds: DAY },
    );

    expect(series).toEqual([
      { timestamp: 0, value: undefined },
      { timestamp: DAY, value: 10 },
      { timestamp: 2 * DAY, value: 10 },
      { timestamp: 3 * DAY, value: 30 },
      { timestamp: 4 * DAY, value: 30 },
    ]);
  });

  it("uses observations before the visible range to seed the first bucket", () => {
    const series = forwardFillSeries([{ timestamp: DAY, value: 10 }], {
      from: 3 * DAY,
      to: 5 * DAY,
      bucketSeconds: DAY,
    });

    expect(series).toEqual([
      { timestamp: 3 * DAY, value: 10 },
      { timestamp: 4 * DAY, value: 10 },
    ]);
  });

  it("aligns mid-bucket observations down to their bucket", () => {
    const series = forwardFillSeries(
      [{ timestamp: DAY + 12 * 3_600, value: 12 }],
      { from: DAY, to: 3 * DAY, bucketSeconds: DAY },
    );

    expect(series).toEqual([
      { timestamp: DAY, value: 12 },
      { timestamp: 2 * DAY, value: 12 },
    ]);
  });

  it("sorts out-of-order input and keeps the latest duplicate-bucket observation", () => {
    const series = forwardFillSeries(
      [
        { timestamp: 2 * DAY, value: 20 },
        { timestamp: DAY, value: 10 },
        { timestamp: DAY + 3_600, value: 11 },
      ],
      { from: DAY, to: 3 * DAY, bucketSeconds: DAY },
    );

    expect(series).toEqual([
      { timestamp: DAY, value: 11 },
      { timestamp: 2 * DAY, value: 20 },
    ]);
  });

  it("returns empty output for empty or zero-width ranges", () => {
    expect(
      forwardFillSeries([], { from: 0, to: 3 * DAY, bucketSeconds: DAY }),
    ).toEqual([
      { timestamp: 0, value: undefined },
      { timestamp: DAY, value: undefined },
      { timestamp: 2 * DAY, value: undefined },
    ]);
    expect(
      forwardFillSeries([{ timestamp: 0, value: 1 }], {
        from: DAY,
        to: DAY,
        bucketSeconds: DAY,
      }),
    ).toEqual([]);
  });
});

describe("zeroFillSeries", () => {
  it("fills missing flow buckets at the start, middle, and end with zero", () => {
    const series = zeroFillSeries(
      [
        { timestamp: DAY, value: 10 },
        { timestamp: 3 * DAY, value: 30 },
      ],
      { from: 0, to: 5 * DAY, bucketSeconds: DAY },
    );

    expect(series).toEqual([
      { timestamp: 0, value: 0 },
      { timestamp: DAY, value: 10 },
      { timestamp: 2 * DAY, value: 0 },
      { timestamp: 3 * DAY, value: 30 },
      { timestamp: 4 * DAY, value: 0 },
    ]);
  });

  it("aligns buckets to the first boundary inside the half-open range", () => {
    const series = zeroFillSeries([{ timestamp: DAY + 30, value: 10 }], {
      from: DAY + 1,
      to: 3 * DAY,
      bucketSeconds: DAY,
    });

    expect(series).toEqual([{ timestamp: 2 * DAY, value: 0 }]);
  });

  it("sorts out-of-order input and keeps the latest duplicate-bucket observation", () => {
    const series = zeroFillSeries(
      [
        { timestamp: 2 * DAY, value: 20 },
        { timestamp: DAY, value: 10 },
        { timestamp: DAY + 3_600, value: 11 },
      ],
      { from: DAY, to: 3 * DAY, bucketSeconds: DAY },
    );

    expect(series).toEqual([
      { timestamp: DAY, value: 11 },
      { timestamp: 2 * DAY, value: 20 },
    ]);
  });

  it("returns empty output for empty or zero-width ranges", () => {
    expect(
      zeroFillSeries([], { from: 0, to: 3 * DAY, bucketSeconds: DAY }),
    ).toEqual([
      { timestamp: 0, value: 0 },
      { timestamp: DAY, value: 0 },
      { timestamp: 2 * DAY, value: 0 },
    ]);
    expect(
      zeroFillSeries([{ timestamp: 0, value: 1 }], {
        from: DAY,
        to: DAY,
        bucketSeconds: DAY,
      }),
    ).toEqual([]);
  });
});
