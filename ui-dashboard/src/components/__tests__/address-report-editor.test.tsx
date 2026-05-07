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

let container: HTMLDivElement;
let root: Root;
let fetchMock: Mock;

function render(
  props: {
    address?: string;
    scope?: "global" | number;
  } = {},
): void {
  act(() => {
    root.render(
      <AddressReportEditor
        address={props.address ?? VALID_ADDR}
        scope={props.scope ?? "global"}
      />,
    );
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
        scope: "global",
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

function clickButton(text: string): void {
  const btn = findButton(text);
  if (!btn) throw new Error(`button "${text}" not found`);
  act(() => {
    btn.click();
  });
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
});

describe("AddressReportEditor — loaded state", () => {
  beforeEach(() => {
    mockSwrData = {
      body: "# Hi",
      title: "T",
      authorEmail: "alice@mentolabs.xyz",
      version: 3,
      scope: "global" as const,
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

  it("shows Saved to scope = data.scope (not parent prop) — regression for #330 codex finding", () => {
    // Parent passes scope=42220 (per-chain) but the report lives in global.
    // The scope display must reflect the persisted scope, not the prop.
    render({ scope: 42220 });
    expect(findByTextIncludes("Saved to scope:")).not.toBeNull();
    expect(findByTextIncludes("All chains")).not.toBeNull();
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

describe("AddressReportEditor — save scope (regression for #330)", () => {
  it("sends scope = data.scope when editing an existing report", async () => {
    // Existing report at global scope; parent passes per-chain scope.
    mockSwrData = {
      body: "old body",
      version: 1,
      scope: "global" as const,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    };
    render({ scope: 42220 });

    // Switch to edit mode + change the body so dirty=true, save enabled.
    clickButton("Edit");
    setTextarea("ar-body", "old body — with edits");
    await act(async () => {
      findButton("Save changes")?.click();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // scope must be the report's persisted scope, not the parent's prop.
    expect(body.scope).toBe("global");
    expect(body.address).toBe(VALID_ADDR);
  });

  it("sends scope = parent prop when creating a new report", async () => {
    mockSwrData = null; // no existing report
    render({ scope: 42220 });
    setTextarea("ar-body", "first draft");
    await act(async () => {
      findButton("Save report")?.click();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scope).toBe(42220);
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
});
