/** @vitest-environment jsdom */

/**
 * Unit tests for `useTableSort`.
 *
 * Pattern: jsdom + `react-dom/client` + `act` — no @testing-library/react
 * (not installed in this repo). The hook is exercised via a minimal wrapper
 * component that exposes its return values as data attributes on a div.
 */

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import.
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/",
}));

import { useTableSort } from "@/lib/use-table-sort";
import type { UseTableSortResult } from "@/lib/use-table-sort";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type TestKey = "pool" | "tvl" | "volume24h";
const VALID_KEYS: ReadonlySet<TestKey> = new Set(["pool", "tvl", "volume24h"]);

type LeaderboardKey = "pool" | "fees7d" | "fees24h";
const LEADERBOARD_KEYS: ReadonlySet<LeaderboardKey> = new Set([
  "pool",
  "fees7d",
  "fees24h",
]);

// ---------------------------------------------------------------------------
// Wrapper components that expose hook state to the DOM
// ---------------------------------------------------------------------------

interface ResultRef {
  current: UseTableSortResult<TestKey> | null;
}

function HookWrapper({
  prefix,
  resultRef,
}: {
  prefix?: string;
  resultRef: ResultRef;
}) {
  const result = useTableSort<TestKey>({
    defaultKey: "tvl",
    defaultDir: "desc",
    validKeys: VALID_KEYS,
    paramPrefix: prefix ?? "",
  });
  resultRef.current = result;
  return null;
}

interface LeaderboardResultRef {
  current: UseTableSortResult<LeaderboardKey> | null;
}

function LeaderboardHookWrapper({
  resultRef,
}: {
  resultRef: LeaderboardResultRef;
}) {
  const result = useTableSort<LeaderboardKey>({
    defaultKey: "fees7d",
    defaultDir: "desc",
    validKeys: LEADERBOARD_KEYS,
    paramPrefix: "leaderboard",
  });
  resultRef.current = result;
  return null;
}

// ---------------------------------------------------------------------------
// DOM setup helpers
// ---------------------------------------------------------------------------

let container: HTMLElement;
let root: Root;
let setupActive = false;

function setup(params: URLSearchParams = new URLSearchParams()) {
  mockSearchParams = params;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setupActive = true;
}

function teardown() {
  if (!setupActive) return;
  setupActive = false;
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  setupActive = false;
});

// `afterEach` cleans up unconditionally so a failing assertion can't leak the
// DOM container into the next test. Idempotent — no-op when a test (e.g. the
// two-prefix isolation cases below) already cleaned up its own roots.
afterEach(() => {
  teardown();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTableSort — defaults applied when URL has no params", () => {
  it("returns default key and direction when URL is empty", () => {
    setup();
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("desc");
  });
});

describe("useTableSort — URL param round-trips", () => {
  it("reads Sort and Dir params with prefix", () => {
    setup(new URLSearchParams("leaderboardSort=fees24h&leaderboardDir=asc"));
    const ref: LeaderboardResultRef = { current: null };
    act(() => {
      root.render(
        React.createElement(LeaderboardHookWrapper, { resultRef: ref }),
      );
    });
    expect(ref.current?.sortKey).toBe("fees24h");
    expect(ref.current?.sortDir).toBe("asc");
  });

  it("reads Sort and Dir params without prefix", () => {
    setup(new URLSearchParams("Sort=volume24h&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("volume24h");
    expect(ref.current?.sortDir).toBe("asc");
  });
});

describe("useTableSort — invalid sort param falls back to default key", () => {
  it("falls back to defaultKey when sort value is not in validKeys", () => {
    setup(new URLSearchParams("Sort=nonexistent&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("asc");
  });

  it("falls back to defaultDir when dir value is not 'asc' or 'desc'", () => {
    setup(new URLSearchParams("Sort=pool&Dir=random"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("pool");
    expect(ref.current?.sortDir).toBe("desc");
  });
});

describe("useTableSort — handleSort(sameKey) toggles direction", () => {
  it("toggles desc → asc when handleSort called with the active key", () => {
    setup(); // default tvl/desc
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("tvl");
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const callArg = mockReplace.mock.calls[0][0] as string;
    // tvl+asc differs from defaults (tvl/desc), so params should be set
    expect(callArg).toContain("Sort=tvl");
    expect(callArg).toContain("Dir=asc");
  });

  it("toggles asc → desc when handleSort called with the active key", () => {
    setup(new URLSearchParams("Sort=volume24h&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("volume24h");
    });
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=volume24h");
    expect(callArg).toContain("Dir=desc");
  });
});

describe("useTableSort — handleSort(newKey) resets dir to 'desc'", () => {
  it("sets dir=desc and updates key when switching to a different column", () => {
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("volume24h");
    });
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=volume24h");
    expect(callArg).toContain("Dir=desc");
  });
});

describe("useTableSort — strips params when new state matches defaults", () => {
  it("replaces to bare '?' when new state is exactly the defaults", () => {
    // Start on pool/asc, click tvl → tvl/desc matches defaults → strip
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("tvl");
    });
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toBe("/");
  });

  it("keeps params when new state differs from defaults", () => {
    setup(); // default tvl/desc
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("pool");
    });
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=pool");
    expect(callArg).toContain("Dir=desc");
  });
});

describe("useTableSort — canonicalizes malformed / partial URL params on mount", () => {
  it("rewrites bogus sort param to default key while keeping a valid dir", () => {
    setup(new URLSearchParams("Sort=bogus&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("asc");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=tvl");
    expect(callArg).toContain("Dir=asc");
  });

  it("strips both params when bogus sort + invalid dir collapse to defaults", () => {
    setup(new URLSearchParams("Sort=bogus&Dir=garbage"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("desc");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0][0]).toBe("/");
  });

  it("backfills the missing dir param when only sort is present", () => {
    setup(new URLSearchParams("Sort=pool"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("pool");
    expect(ref.current?.sortDir).toBe("desc");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=pool");
    expect(callArg).toContain("Dir=desc");
  });

  it("strips literal-default params (Sort=tvl&Dir=desc) so URL stays canonical", () => {
    setup(new URLSearchParams("Sort=tvl&Dir=desc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0][0]).toBe("/");
  });

  it("does NOT rewrite when URL is already canonical", () => {
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does NOT rewrite when URL is empty (defaults already canonical)", () => {
    setup();
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("useTableSort — handleSort honors defaultDir on new-key reset", () => {
  it("uses defaultDir (asc) when configured, not hard-coded desc", () => {
    setup();
    const ref: { current: UseTableSortResult<TestKey> | null } = {
      current: null,
    };
    function AscDefaultWrapper() {
      const result = useTableSort<TestKey>({
        defaultKey: "tvl",
        defaultDir: "asc",
        validKeys: VALID_KEYS,
      });
      ref.current = result;
      return null;
    }
    act(() => {
      root.render(React.createElement(AscDefaultWrapper));
    });
    // Switching to a new key should reset to defaultDir ("asc"), not "desc".
    act(() => {
      ref.current?.handleSort("pool");
    });
    const callArg = mockReplace.mock.calls[0][0] as string;
    expect(callArg).toContain("Sort=pool");
    expect(callArg).toContain("Dir=asc");
  });

  it("when new state matches defaultDir=asc default, params are stripped", () => {
    // Start on pool/desc, click tvl. defaultDir=asc, so reset is tvl/asc → matches defaults → strip.
    setup(new URLSearchParams("Sort=pool&Dir=desc"));
    const ref: { current: UseTableSortResult<TestKey> | null } = {
      current: null,
    };
    function AscDefaultWrapper() {
      const result = useTableSort<TestKey>({
        defaultKey: "tvl",
        defaultDir: "asc",
        validKeys: VALID_KEYS,
      });
      ref.current = result;
      return null;
    }
    act(() => {
      root.render(React.createElement(AscDefaultWrapper));
    });
    // First call may be the canonicalization — we want the handleSort one.
    mockReplace.mockClear();
    act(() => {
      ref.current?.handleSort("tvl");
    });
    expect(mockReplace.mock.calls[0][0]).toBe("/");
  });
});

describe("useTableSort — rapid toggles compose without dropping intent", () => {
  it("two consecutive toggles on the active key produce two distinct URL writes", () => {
    setup(); // default tvl/desc — same key, same closure across both clicks
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    // Without the intent ref, both calls would compute against the URL-derived
    // sortDir="desc" and both would write `Dir=asc`. With the ref, the second
    // call composes against the first call's intent ("asc") and writes
    // `Dir=desc` (which is the default → params stripped → "/").
    act(() => {
      ref.current?.handleSort("tvl");
      ref.current?.handleSort("tvl");
    });
    expect(mockReplace).toHaveBeenCalledTimes(2);
    const first = mockReplace.mock.calls[0][0] as string;
    const second = mockReplace.mock.calls[1][0] as string;
    expect(first).toContain("Sort=tvl");
    expect(first).toContain("Dir=asc");
    // tvl/desc matches the defaults, so the second toggle strips params.
    expect(second).toBe("/");
  });

  it("intent ref resets when URL search params change, so external nav wins", () => {
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    // First click composes off the URL state (pool/asc) → toggle to pool/desc.
    act(() => {
      ref.current?.handleSort("pool");
    });
    expect(mockReplace.mock.calls[0][0] as string).toContain("Dir=desc");

    // Simulate external navigation: search params switch to a different state.
    // The mounted hook re-renders, the [sortKey, sortDir] effect fires, and
    // the intent ref is cleared. Subsequent toggle should compose off the
    // NEW URL state, not the stale ref.
    mockSearchParams = new URLSearchParams("Sort=tvl&Dir=desc");
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });

    act(() => {
      ref.current?.handleSort("tvl");
    });
    // Latest call: from tvl/desc, toggle on same key → tvl/asc.
    const latest = mockReplace.mock.calls[
      mockReplace.mock.calls.length - 1
    ][0] as string;
    expect(latest).toContain("Sort=tvl");
    expect(latest).toContain("Dir=asc");
  });
});

describe("useTableSort — two hooks with different paramPrefix don't interfere", () => {
  let container2: HTMLElement;
  let root2: Root;
  let ref: ResultRef;
  let ref2: LeaderboardResultRef;

  it("reads from separate prefix-scoped params independently", () => {
    mockSearchParams = new URLSearchParams(
      "leaderboardSort=fees24h&leaderboardDir=asc&poolsSort=pool&poolsDir=asc",
    );
    container = document.createElement("div");
    container2 = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(container2);
    root = createRoot(container);
    root2 = createRoot(container2);
    ref = { current: null };
    ref2 = { current: null };

    act(() => {
      root.render(
        React.createElement(LeaderboardHookWrapper, { resultRef: ref2 }),
      );
      root2.render(
        React.createElement(HookWrapper, {
          prefix: "pools",
          resultRef: ref,
        }),
      );
    });

    expect(ref2.current?.sortKey).toBe("fees24h");
    expect(ref2.current?.sortDir).toBe("asc");
    expect(ref.current?.sortKey).toBe("pool");
    expect(ref.current?.sortDir).toBe("asc");

    act(() => {
      root.unmount();
      root2.unmount();
    });
    document.body.removeChild(container);
    document.body.removeChild(container2);
  });

  it("handleSort on one prefix preserves the other prefix's params in the URL", () => {
    mockSearchParams = new URLSearchParams(
      "leaderboardSort=fees24h&leaderboardDir=asc",
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    ref = { current: null };

    act(() => {
      root.render(
        React.createElement(HookWrapper, { prefix: "pools", resultRef: ref }),
      );
    });

    act(() => {
      ref.current?.handleSort("volume24h");
    });

    const callArg = mockReplace.mock.calls[0][0] as string;
    // leaderboard params should be preserved
    expect(callArg).toContain("leaderboardSort=fees24h");
    expect(callArg).toContain("leaderboardDir=asc");
    // pools params should now be set
    expect(callArg).toContain("poolsSort=volume24h");
    expect(callArg).toContain("poolsDir=desc");

    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });
});
