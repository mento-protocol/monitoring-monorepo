// Pure, browser-free helpers for measure-inp.mjs, extracted so the readiness
// timeout selection and terminal-state classification can be unit-tested
// without launching Chromium (#775). measure-inp.mjs is a blocking CI gate, so
// drift in this logic can send maintainers toward the wrong fix; the tests in
// measure-inp-lib.test.mjs pin the behaviour.

// How long to wait for a surface's readiness anchor before failing. Most
// surfaces settle in well under this. `/volume` overrides it: it fires the
// heaviest query waterfall on the page (top-traders + aggregator + broker +
// pools snapshots, then client-side re-aggregation), and on a cold preview
// deployment hit by a contended CI runner the sorted "Volume" header can take
// longer than the default to render. A warm-backend readiness ceiling measured
// at 20× CPU + Slow 4G is ~12s, so the override leaves headroom for preview
// cold-start latency without masking a genuine hang (a true stall still trips
// the override and fails closed).
export const DEFAULT_READY_TIMEOUT_MS = 20_000;
export const VOLUME_READY_TIMEOUT_MS = 45_000;

// A surface uses its explicit readyTimeout when set, else the default.
export function resolveReadyTimeout(surface) {
  return surface.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;
}

// Source for the EmptyBox copy the `/volume` tables render when a window
// legitimately has no rows (top-traders `VolumeTable` and the v2/v3
// `AggregatorBreakdownSection`). Kept as a string so measure-inp.mjs can inject
// it into `page.evaluate` (which can't close over a module import) while this
// module stays the single source of truth the tests assert against.
export const EMPTY_VOLUME_MARKER_PATTERN =
  "no traders (matched|left)|no v[23] aggregator (activity|volume)";

// True when page body text contains one of the `/volume` empty-state messages.
export function matchesEmptyVolumeMarker(bodyText) {
  return new RegExp(EMPTY_VOLUME_MARKER_PATTERN, "i").test(bodyText);
}

// Turn the DOM markers captured after a readiness timeout into a human cause.
// The bare "Timeout exceeded" can't tell slow-render from empty/error data, and
// each needs a different fix. `error` takes priority (a backend failure is the
// most actionable), then `loading`, then `empty`.
export function classifyTerminalState({ loading, error, empty }) {
  if (error) return "data backend erroring (ErrorBox / role=alert present)";
  if (loading)
    return "still loading after timeout (slow data fetch/render — likely preview cold-start)";
  if (empty) return "no data (EmptyBox present — window legitimately empty)";
  return "unknown (no loading/error/empty marker found)";
}

// Cause string for when the page itself died before it could be classified
// (Target closed, crash, GC during the wait). The caller always rethrows the
// primary timeout error; this only annotates why classification was
// unavailable, so the more useful signal is never erased.
export function unavailableTerminalState(diagMessage) {
  return `unavailable (page closed/crashed before it could be classified: ${diagMessage})`;
}
