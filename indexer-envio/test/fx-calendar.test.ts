/// <reference types="mocha" />
import { strict as assert } from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("FX calendar config", () => {
  const vendored = JSON.parse(
    readFileSync(join(__dirname, "..", "config", "fx-calendar.json"), "utf8"),
  );
  const shared = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "shared-config", "fx-calendar.json"),
      "utf8",
    ),
  );

  it("keeps the vendored indexer copy in sync with shared-config", () => {
    assert.deepEqual(
      vendored,
      shared,
      "indexer-envio/config/fx-calendar.json must match shared-config/fx-calendar.json",
    );
  });

  it("anchor is a real Friday at the configured close hour UTC", () => {
    // Guard against drift between anchorFri2100UnixSec and the close constants.
    // The anchor must land on the weekday + hour declared elsewhere in the same
    // file, otherwise weekend-overlap math walks out of alignment.
    const d = new Date(shared.anchorFri2100UnixSec * 1000);
    assert.equal(d.getUTCDay(), shared.fxCloseDay);
    assert.equal(d.getUTCHours(), shared.fxCloseHourUtc);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCSeconds(), 0);
  });
});
