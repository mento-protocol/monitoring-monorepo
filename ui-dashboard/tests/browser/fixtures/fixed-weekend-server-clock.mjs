import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "node:http";

// Loaded only into the Playwright-managed Next.js process. A request opts in
// with this fixture-only header; AsyncLocalStorage keeps concurrent requests
// isolated, so unmarked routes always retain the real server clock.
const FIXED_CLOCK_HEADER = "x-playwright-fixed-weekend-clock";
const fixedClockScope = new AsyncLocalStorage();
const originalServerEmit = Server.prototype.emit;

Server.prototype.emit = function emitWithFixedClockScope(event, ...args) {
  if (event !== "request") return originalServerEmit.call(this, event, ...args);
  const [request] = args;
  const useFixedClock = request?.headers?.[FIXED_CLOCK_HEADER] === "true";
  return fixedClockScope.run(useFixedClock, () =>
    originalServerEmit.call(this, event, ...args),
  );
};

// `isWeekend()` reads a zero-argument `new Date()`, so pin only that path to
// Saturday for marked requests while leaving Date.now() real. SSR cache ages
// and data windows keep the same clock they use outside this focused fixture.
const RealDate = globalThis.Date;
const realNow = RealDate.now.bind(RealDate);
const fixtureOriginMs = RealDate.parse("2026-04-18T12:00:00Z");

function FixedWeekendServerDate(...args) {
  const useFixedClock = fixedClockScope.getStore() === true;
  if (!new.target) {
    return useFixedClock
      ? new RealDate(fixtureOriginMs).toString()
      : RealDate();
  }
  return Reflect.construct(
    RealDate,
    args.length === 0 && useFixedClock ? [fixtureOriginMs] : args,
    new.target,
  );
}

Object.setPrototypeOf(FixedWeekendServerDate, RealDate);
FixedWeekendServerDate.prototype = RealDate.prototype;
FixedWeekendServerDate.now = realNow;
FixedWeekendServerDate.parse = RealDate.parse;
FixedWeekendServerDate.UTC = RealDate.UTC;
globalThis.Date = FixedWeekendServerDate;
