import { describe, expect, it } from "vitest";
import fxCalendarJson from "../fx-calendar.json" with { type: "json" };
import FX_CALENDAR, {
  ANCHOR_FRI_2100_UNIX_SEC,
  FX_CLOSE_DAY,
  FX_CLOSE_HOUR_UTC,
  FX_REOPEN_DAY,
  FX_REOPEN_HOUR_UTC,
  assertFxCalendarConfig,
} from "../src/fx-calendar";

describe("fx calendar", () => {
  it("exports the canonical FX calendar JSON", () => {
    expect(FX_CALENDAR).toEqual(fxCalendarJson);
  });

  it("exposes named constants for market-hour math", () => {
    expect(FX_CLOSE_DAY).toBe(fxCalendarJson.fxCloseDay);
    expect(FX_CLOSE_HOUR_UTC).toBe(fxCalendarJson.fxCloseHourUtc);
    expect(FX_REOPEN_DAY).toBe(fxCalendarJson.fxReopenDay);
    expect(FX_REOPEN_HOUR_UTC).toBe(fxCalendarJson.fxReopenHourUtc);
    expect(ANCHOR_FRI_2100_UNIX_SEC).toBe(fxCalendarJson.anchorFri2100UnixSec);
  });

  it("validates the FX calendar JSON shape", () => {
    expect(() => assertFxCalendarConfig(fxCalendarJson)).not.toThrow();
    expect(() => assertFxCalendarConfig(null)).toThrow(
      "fx-calendar.json must be an object",
    );
    expect(() => assertFxCalendarConfig([])).toThrow(
      "fx-calendar.json must be an object",
    );
    expect(() =>
      assertFxCalendarConfig({
        ...fxCalendarJson,
        fxCloseDay: "5",
      }),
    ).toThrow("fx-calendar.json field fxCloseDay must be a number");
  });
});
