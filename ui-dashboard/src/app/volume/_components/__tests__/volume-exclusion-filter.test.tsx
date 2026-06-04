/** @vitest-environment jsdom */

import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolumeExclusionFilter } from "../volume-exclusion-filter";
import type { VolumeExclusionState } from "@/lib/volume-exclusions";

// Match the repo's jsdom + react-dom/client test pattern.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = "0x00000000000000000000000000000000000000aa";

let container: HTMLElement;
let root: Root;

function Host({
  allowSourceExclusions = true,
}: {
  allowSourceExclusions?: boolean;
}) {
  const [exclusions, setExclusions] = useState<VolumeExclusionState>({
    addresses: [],
    sources: [],
  });
  return (
    <VolumeExclusionFilter
      exclusions={exclusions}
      allowSourceExclusions={allowSourceExclusions}
      sourceOptions={[]}
      onChange={setExclusions}
    />
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Host />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setInputValue(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    "#volume-exclusion-input",
  );
  if (!input) throw new Error("missing exclusion input");
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!valueSetter) throw new Error("missing input value setter");
  act(() => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickAdd() {
  const addButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Add",
  );
  if (!addButton) throw new Error("missing Add button");
  act(() => {
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("VolumeExclusionFilter", () => {
  it("clears ignored-token warnings after a mixed valid add succeeds", () => {
    setInputValue(`${ADDRESS} bad!token`);
    clickAdd();

    expect(container.textContent).toContain("0x0000...00aa");
    expect(container.textContent).not.toContain("Ignored:");
  });

  it("does not add source exclusions when source filtering is disabled", () => {
    act(() => {
      root.render(<Host allowSourceExclusions={false} />);
    });

    setInputValue("cluster-abc");
    clickAdd();

    expect(container.textContent).toContain("No exploratory exclusions.");
    expect(container.textContent).toContain("Ignored: cluster-abc");
  });
});
