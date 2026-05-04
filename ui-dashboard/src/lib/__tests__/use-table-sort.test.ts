/** @vitest-environment jsdom */

/**
 * Unit tests for `useTableSort`.
 *
 * Pattern: jsdom + `react-dom/client` + `act` — no @testing-library/react
 * (not installed in this repo). The hook is exercised via a minimal wrapper
 * component that exposes its return values as data attributes on a div.
 *
 * URL persistence is tested via `window.location.search` after `act()` (and
 * a spy on `window.history.replaceState`), not via `router.replace`. The hook
 * intentionally bypasses Next.js routing to avoid an RSC refetch on every
 * sort click — see the hook's JSDoc for the perf rationale.
 */

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import.
// ---------------------------------------------------------------------------

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
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
let replaceStateSpy: ReturnType<typeof vi.spyOn>;

function syncLocation(params: URLSearchParams) {
  // Reset jsdom's `window.location` to match the mocked search params so the
  // hook's `replaceState`-based URL updates compose against the right base.
  // jsdom doesn't allow direct assignment to `location.search`, so we go
  // through `history.replaceState`.
  const qs = params.toString();
  const url = qs ? `/?${qs}` : "/";
  window.history.replaceState(window.history.state, "", url);
}

function setup(params: URLSearchParams = new URLSearchParams()) {
  mockSearchParams = params;
  syncLocation(params);
  // Re-spy after syncLocation so the spy only sees calls made by the hook,
  // not by our test setup.
  replaceStateSpy = vi.spyOn(window.history, "replaceState");
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
  replaceStateSpy?.mockRestore();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  syncLocation(mockSearchParams);
  setupActive = false;
});

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
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("asc");
    expect(window.location.search).toContain("Sort=tvl");
    expect(window.location.search).toContain("Dir=asc");
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
    expect(ref.current?.sortKey).toBe("volume24h");
    expect(ref.current?.sortDir).toBe("desc");
    expect(window.location.search).toContain("Sort=volume24h");
    expect(window.location.search).toContain("Dir=desc");
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
    expect(ref.current?.sortKey).toBe("volume24h");
    expect(ref.current?.sortDir).toBe("desc");
    expect(window.location.search).toContain("Sort=volume24h");
    expect(window.location.search).toContain("Dir=desc");
  });
});

describe("useTableSort — strips params when new state matches defaults", () => {
  it("clears search to '' when new state is exactly the defaults", () => {
    // Start on pool/asc, click tvl → tvl/desc matches defaults → strip
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    act(() => {
      ref.current?.handleSort("tvl");
    });
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/");
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
    expect(window.location.search).toContain("Sort=pool");
    expect(window.location.search).toContain("Dir=desc");
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
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("Sort=tvl");
    expect(window.location.search).toContain("Dir=asc");
  });

  it("strips both params when bogus sort + invalid dir collapse to defaults", () => {
    setup(new URLSearchParams("Sort=bogus&Dir=garbage"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("desc");
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
  });

  it("backfills the missing dir param when only sort is present", () => {
    setup(new URLSearchParams("Sort=pool"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(ref.current?.sortKey).toBe("pool");
    expect(ref.current?.sortDir).toBe("desc");
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("Sort=pool");
    expect(window.location.search).toContain("Dir=desc");
  });

  it("strips literal-default params (Sort=tvl&Dir=desc) so URL stays canonical", () => {
    setup(new URLSearchParams("Sort=tvl&Dir=desc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
  });

  it("does NOT rewrite when URL is already canonical", () => {
    setup(new URLSearchParams("Sort=pool&Dir=asc"));
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("does NOT rewrite when URL is empty (defaults already canonical)", () => {
    setup();
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    expect(replaceStateSpy).not.toHaveBeenCalled();
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
    expect(ref.current?.sortDir).toBe("asc");
    expect(window.location.search).toContain("Sort=pool");
    expect(window.location.search).toContain("Dir=asc");
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
    act(() => {
      ref.current?.handleSort("tvl");
    });
    expect(window.location.search).toBe("");
  });
});

describe("useTableSort — rapid toggles compose without dropping intent", () => {
  it("two consecutive toggles on the active key produce the expected final state", () => {
    setup(); // default tvl/desc — same key, same closure across both clicks
    const ref: ResultRef = { current: null };
    act(() => {
      root.render(React.createElement(HookWrapper, { resultRef: ref }));
    });
    // With state-driven `handleSort`, `setState`'s functional updater always
    // sees the latest local state — two desc-keyed clicks must compose to
    // desc → asc → desc, not stall at desc → asc → asc. The desc final state
    // matches the defaults, so URL params get stripped.
    act(() => {
      ref.current?.handleSort("tvl");
      ref.current?.handleSort("tvl");
    });
    expect(ref.current?.sortKey).toBe("tvl");
    expect(ref.current?.sortDir).toBe("desc");
    // Final URL: defaults match → no params.
    expect(window.location.search).toBe("");
  });
});

describe("useTableSort — two hooks with different paramPrefix don't interfere", () => {
  let container2: HTMLElement;
  let root2: Root;
  let ref: ResultRef;
  let ref2: LeaderboardResultRef;

  it("reads from separate prefix-scoped params independently", () => {
    setup(
      new URLSearchParams(
        "leaderboardSort=fees24h&leaderboardDir=asc&poolsSort=pool&poolsDir=asc",
      ),
    );
    container2 = document.createElement("div");
    document.body.appendChild(container2);
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
      root2.unmount();
    });
    document.body.removeChild(container2);
  });

  it("handleSort on one prefix preserves the other prefix's params in the URL", () => {
    setup(new URLSearchParams("leaderboardSort=fees24h&leaderboardDir=asc"));
    ref = { current: null };

    act(() => {
      root.render(
        React.createElement(HookWrapper, { prefix: "pools", resultRef: ref }),
      );
    });

    act(() => {
      ref.current?.handleSort("volume24h");
    });

    // Other prefix's params survive untouched
    expect(window.location.search).toContain("leaderboardSort=fees24h");
    expect(window.location.search).toContain("leaderboardDir=asc");
    // Our prefix's params now reflect the click
    expect(window.location.search).toContain("poolsSort=volume24h");
    expect(window.location.search).toContain("poolsDir=desc");
  });
});
