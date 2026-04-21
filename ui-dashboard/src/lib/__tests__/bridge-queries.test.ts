import { describe, it, expect } from "vitest";
import {
  BRIDGE_TRANSFERS_WINDOW,
  BRIDGE_TRANSFERS_COUNT,
  BRIDGE_PENDING_IDS,
  BRIDGE_DELIVERED_RECENT,
  BRIDGE_DAILY_SNAPSHOT,
} from "../bridge-queries";

// Hasura silently drops fields from multi-key object-syntax `order_by`
// (`{a: desc, b: asc}`) — rows come back sorted by a single key only.
// Array syntax `[{a: desc}, {b: asc}]` is the documented multi-key form.
// Pin every multi-key bridge query to array syntax so a future author
// can't regress to the broken form. Precedent:
// `use-all-networks-data.test.ts` asserts the same shape for pool queries.
describe("bridge-queries order_by uses array syntax", () => {
  const cases: Array<[string, string]> = [
    ["BRIDGE_TRANSFERS_WINDOW", BRIDGE_TRANSFERS_WINDOW],
    ["BRIDGE_TRANSFERS_COUNT", BRIDGE_TRANSFERS_COUNT],
    ["BRIDGE_PENDING_IDS", BRIDGE_PENDING_IDS],
    ["BRIDGE_DELIVERED_RECENT", BRIDGE_DELIVERED_RECENT],
    ["BRIDGE_DAILY_SNAPSHOT", BRIDGE_DAILY_SNAPSHOT],
  ];

  for (const [name, query] of cases) {
    it(`${name} sorts with array-syntax order_by`, () => {
      expect(query).toMatch(/order_by:\s*\[/);
    });
  }
});
