import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  formatUnmatchedScratchDrainWarning,
  warnUnmatchedScratchDrain,
} from "../src/wormhole/scratchWarnings.js";

const event = {
  chainId: 143,
  transaction: {
    hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
  },
  logIndex: 7,
};

describe("wormhole scratch warnings", () => {
  it("formats unmatched scratch drains with the scratch entity and event key", () => {
    const warning = formatUnmatchedScratchDrainWarning(
      event,
      "WormholeDestPending",
    );

    assert.match(warning, /WormholeDestPending/);
    assert.match(warning, /chain=143/);
    assert.match(warning, /logIndex=7/);
    assert.match(warning, /should be 0 in steady state/);
  });

  it("emits the formatted warning through context.log.warn", () => {
    const warnings: string[] = [];
    warnUnmatchedScratchDrain(
      {
        log: {
          warn: (message) => warnings.push(message),
        },
      },
      event,
      "WormholeTransferPending",
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /WormholeTransferPending/);
  });
});
