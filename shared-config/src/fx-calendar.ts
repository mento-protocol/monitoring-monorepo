import fxCalendarJson from "../fx-calendar.json" with { type: "json" };

export type FxCalendarConfig = {
  fxCloseDay: number;
  fxCloseHourUtc: number;
  fxReopenDay: number;
  fxReopenHourUtc: number;
  anchorFri2100UnixSec: number;
};

export const FX_CALENDAR = fxCalendarJson as FxCalendarConfig;

export const FX_CLOSE_DAY = FX_CALENDAR.fxCloseDay;
export const FX_CLOSE_HOUR_UTC = FX_CALENDAR.fxCloseHourUtc;
export const FX_REOPEN_DAY = FX_CALENDAR.fxReopenDay;
export const FX_REOPEN_HOUR_UTC = FX_CALENDAR.fxReopenHourUtc;
export const ANCHOR_FRI_2100_UNIX_SEC = FX_CALENDAR.anchorFri2100UnixSec;

export default FX_CALENDAR;
