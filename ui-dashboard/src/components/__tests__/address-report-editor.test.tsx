/** @vitest-environment jsdom */
/**
 * Interaction tests for `AddressReportEditor`. Pinned regressions:
 * - Save scope uses `data?.scope ?? scope` so editing an existing report
 *   never silently moves it to the parent label tab's scope.
 * - SWR `error` state surfaces explicitly; a Redis read failure must NOT
 *   collapse into the same UI as "no report yet" (codex reviewed in PR #330).
 *
 * Test stack matches the codebase precedent: jsdom + react-dom/client + act.
 * No @testing-library/react (not a dep here).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---- Mocks (hoisted) -------------------------------------------------------

// Capture the SWR fetcher so we can resolve / reject it per test.
let mockSwrData: unknown = undefined;
let mockSwrError: unknown = undefined;
let mockSwrIsLoading = false;
const mockSwrMutate = vi.fn();
const mockGlobalMutate = vi.fn();

vi.mock("swr", () => ({
  default: () => ({
    data: mockSwrData,
    error: mockSwrError,
    isLoading: mockSwrIsLoading,
    mutate: mockSwrMutate,
  }),
  useSWRConfig: () => ({ mutate: mockGlobalMutate }),
}));

// MarkdownRenderer pulls react-markdown; stub to a plain pre so tests don't
// need to load the bundle.
vi.mock("@/components/markdown-renderer", () => ({
  MarkdownRenderer: ({ children }: { children: string }) => (
    <pre data-testid="markdown">{children}</pre>
  ),
}));

vi.mock("@/hooks/use-address-reports-index", () => ({
  ADDRESS_REPORTS_INDEX_SWR_KEY: "address-reports:index",
}));

// ---- SUT -------------------------------------------------------------------

import { AddressReportEditor } from "@/components/address-report-editor";

// ---- DOM setup -------------------------------------------------------------

const VALID_ADDR = "0xb64c8b0a3F8008d5028D8F9323b858F17b18C3C4";
const SECOND_VALID_ADDR = "0x1111111111111111111111111111111111111111";

let container: HTMLDivElement;
let root: Root;
let fetchMock: Mock;

function render(
  props: {
    address?: string;
  } = {},
): void {
  act(() => {
    root.render(<AddressReportEditor address={props.address ?? VALID_ADDR} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  // Reset SWR state between tests.
  mockSwrData = undefined;
  mockSwrError = undefined;
  mockSwrIsLoading = false;
  mockSwrMutate.mockReset();
  mockGlobalMutate.mockReset();

  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ok: true,
      report: {
        body: "x",
        version: 1,
        createdAt: "2026-05-07T00:00:00Z",
        updatedAt: "2026-05-07T00:00:00Z",
      },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

// ---- Helpers ---------------------------------------------------------------

function findByText(text: string): HTMLElement | null {
  return (
    (Array.from(container.querySelectorAll("*")).find(
      (el) => el.textContent?.trim() === text,
    ) as HTMLElement | undefined) ?? null
  );
}

function findByTextIncludes(text: string): HTMLElement | null {
  return (
    (Array.from(container.querySelectorAll("p, div, span")).find((el) =>
      (el.textContent ?? "").includes(text),
    ) as HTMLElement | undefined) ?? null
  );
}

function findButton(text: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function setTextarea(id: string, value: string): void {
  const ta = container.querySelector(`#${id}`) as HTMLTextAreaElement | null;
  if (!ta) throw new Error(`textarea #${id} not found`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(ta, value);
  act(() => {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setInput(id: string, value: string): void {
  const input = container.querySelector(`#${id}`) as HTMLInputElement | null;
  if (!input) throw new Error(`input #${id} not found`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ---- Tests -----------------------------------------------------------------

describe("AddressReportEditor — invalid address", () => {
  it("shows the address-required hint instead of the editor", () => {
    render({ address: "" });
    expect(container.textContent).toContain("Enter a valid address on the");
    expect(container.querySelector("#ar-body")).toBeNull();
  });
});

describe("AddressReportEditor — empty state", () => {
  it("renders the no-report copy and Save report button when SWR returns null", () => {
    mockSwrData = null;
    render();
    expect(findByText("No report yet — write one below.")).not.toBeNull();
    expect(findButton("Save report")).not.toBeNull();
    expect(findButton("Edit")).toBeNull();
    expect(findButton("Preview")).toBeNull();
  });

  it("resets the draft when the address changes and both addresses are empty-state reports", () => {
    mockSwrData = null;
    render({ address: VALID_ADDR });
    setTextarea("ar-body", "draft for the first address");

    render({ address: SECOND_VALID_ADDR });

    const textarea = container.querySelector("#ar-body") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });
});

describe("AddressReportEditor — loaded state", () => {
  beforeEach(() => {
    mockSwrData = {
      body: "# Hi",
      title: "T",
      authorEmail: "alice@mentolabs.xyz",
      version: 3,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    };
  });

  it("shows version + author + Edit/Preview toggle", () => {
    render();
    expect(findByTextIncludes("v3")).not.toBeNull();
    expect(findByTextIncludes("alice@mentolabs.xyz")).not.toBeNull();
    expect(findButton("Edit")).not.toBeNull();
    expect(findButton("Preview")).not.toBeNull();
    expect(findButton("Save changes")).not.toBeNull();
  });

  it("rehydrates existing-report fields when the address changes but updatedAt and version collide", () => {
    mockSwrData = {
      body: "# Report A",
      title: "Report A",
      authorEmail: "alice@mentolabs.xyz",
      version: 3,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    };
    render({ address: VALID_ADDR });
    act(() => {
      findButton("Edit")?.click();
    });
    setInput("ar-title", "Draft title for address A");
    setTextarea("ar-body", "draft body for address A");

    mockSwrData = {
      body: "# Report B",
      title: "Report B",
      authorEmail: "bob@mentolabs.xyz",
      version: 3,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    };
    render({ address: SECOND_VALID_ADDR });
    act(() => {
      findButton("Edit")?.click();
    });

    const titleInput = container.querySelector("#ar-title") as HTMLInputElement;
    const textarea = container.querySelector("#ar-body") as HTMLTextAreaElement;
    expect(titleInput.value).toBe("Report B");
    expect(textarea.value).toBe("# Report B");
  });
});

describe("AddressReportEditor — load error", () => {
  it("shows error UI + Retry button instead of empty state when SWR fails", () => {
    mockSwrError = new Error("network down");
    mockSwrData = undefined;
    render();
    // Error UI MUST appear so the user knows it's a load failure, not an
    // empty record. Without this they could type into what looks like an
    // empty form and silently overwrite the existing report on save.
    expect(findByTextIncludes("Could not load this report")).not.toBeNull();
    expect(findByTextIncludes("network down")).not.toBeNull();
    expect(findButton("Retry")).not.toBeNull();
    // The empty-state copy must NOT also appear.
    expect(findByText("No report yet — write one below.")).toBeNull();
    // The body textarea must not be rendered (would tempt a destructive save).
    expect(container.querySelector("#ar-body")).toBeNull();
  });

  it("Retry calls mutate to re-fetch", () => {
    mockSwrError = new Error("transient");
    mockSwrData = undefined;
    render();
    findButton("Retry")?.click();
    expect(mockSwrMutate).toHaveBeenCalledOnce();
  });
});

describe("AddressReportEditor — save", () => {
  it("keeps Save disabled while the initial lookup is still loading", () => {
    mockSwrData = undefined;
    mockSwrError = undefined;
    mockSwrIsLoading = true;
    render();
    setTextarea("ar-body", "typed before the lookup settled");

    expect(findButton("Save report")?.disabled).toBe(true);
  });

  it("sends only address + body + title (no scope or version precondition) on new-report save", async () => {
    mockSwrData = null;
    render();
    setTextarea("ar-body", "first draft");
    await act(async () => {
      findButton("Save report")?.click();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/address-reports");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.address).toBe(VALID_ADDR);
    expect(body.body).toBe("first draft");
    // Reports are address-keyed only — no scope in the request body.
    expect(body.scope).toBeUndefined();
    expect(body.baseVersion).toBeUndefined();
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("sends the current report version header as the save precondition when editing", async () => {
    mockSwrData = {
      body: "# Hi",
      title: "T",
      authorEmail: "alice@mentolabs.xyz",
      version: 3,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    };
    render();
    act(() => {
      findButton("Edit")?.click();
    });
    setTextarea("ar-body", "# Updated");

    await act(async () => {
      findButton("Save changes")?.click();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.baseVersion).toBeUndefined();
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
      "If-Match": '"3"',
    });
  });

  it("save fetch uses AbortSignal.timeout (defense against wedged TCP)", async () => {
    mockSwrData = null;
    render();
    setTextarea("ar-body", "x");
    await act(async () => {
      findButton("Save report")?.click();
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("on save, refreshes the index but not per-scope aliases (none exist)", async () => {
    mockSwrData = null;
    render();
    setTextarea("ar-body", "x");
    await act(async () => {
      findButton("Save report")?.click();
    });

    // Only the lightweight address-reports index gets refreshed via
    // globalMutate — there are no per-scope aliases under the global-only
    // model so we don't need a predicate-based invalidation.
    const calls = mockGlobalMutate.mock.calls;
    expect(calls.some((c) => c[0] === "address-reports:index")).toBe(true);
    expect(calls.some((c) => typeof c[0] === "function")).toBe(false);
  });
});
