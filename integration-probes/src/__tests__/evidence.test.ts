import { describe, expect, it } from "vitest";
import { detectEvidence } from "../evidence.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";

describe("detectEvidence", () => {
  it("passes on router address evidence", () => {
    const result = detectEvidence(
      { transactionRequest: { to: ROUTER }, route: [{ name: "Mento" }] },
      { routerAddresses: [ROUTER], poolAddresses: [POOL] },
    );

    expect(result.passes).toBe(true);
    expect(result.evidence).toEqual([
      {
        type: "router-address",
        value: ROUTER,
        path: "$.transactionRequest.to",
      },
    ]);
    expect(result.sourceLabels).toEqual(["Mento"]);
    expect(result.txTarget).toBe(ROUTER);
  });

  it("passes on pool address evidence inside nested route payloads", () => {
    const result = detectEvidence(
      { steps: [{ estimate: { data: `swap through ${POOL}` } }] },
      { routerAddresses: [ROUTER], poolAddresses: [POOL] },
    );

    expect(result.passes).toBe(true);
    expect(result.evidence[0]?.type).toBe("pool-address");
  });

  it("does not pass on label-only Mento evidence", () => {
    const result = detectEvidence(
      { route: [{ protocol: "Mento" }] },
      { routerAddresses: [ROUTER], poolAddresses: [POOL] },
    );

    expect(result.passes).toBe(false);
    expect(result.sourceLabels).toEqual(["Mento"]);
    expect(result.evidence).toEqual([]);
  });
});
