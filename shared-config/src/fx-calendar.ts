import fxCalendarJson from "../fx-calendar.json" with { type: "json" };

export type FxCalendarConfig = {
  fxCloseDay: number;
  fxCloseHourUtc: number;
  fxReopenDay: number;
  fxReopenHourUtc: number;
  anchorFri2100UnixSec: number;
};

const FX_CALENDAR_NUMBER_FIELDS = [
  "fxCloseDay",
  "fxCloseHourUtc",
  "fxReopenDay",
  "fxReopenHourUtc",
  "anchorFri2100UnixSec",
] as const satisfies readonly (keyof FxCalendarConfig)[];

export function assertFxCalendarConfig(
  value: unknown,
): asserts value is FxCalendarConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fx-calendar.json must be an object");
  }

  const record = value as Record<string, unknown>;
  for (const field of FX_CALENDAR_NUMBER_FIELDS) {
    if (typeof record[field] !== "number") {
      throw new TypeError(`fx-calendar.json field ${field} must be a number`);
    }
  }
}

assertFxCalendarConfig(fxCalendarJson);

export const FX_CALENDAR = fxCalendarJson;

export const FX_CLOSE_DAY = FX_CALENDAR.fxCloseDay;
export const FX_CLOSE_HOUR_UTC = FX_CALENDAR.fxCloseHourUtc;
export const FX_REOPEN_DAY = FX_CALENDAR.fxReopenDay;
export const FX_REOPEN_HOUR_UTC = FX_CALENDAR.fxReopenHourUtc;
export const ANCHOR_FRI_2100_UNIX_SEC = FX_CALENDAR.anchorFri2100UnixSec;

export default FX_CALENDAR;
