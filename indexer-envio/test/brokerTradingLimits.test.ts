import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { BrokerTradingLimit } from "envio";
import {
  BROKER_LIMIT_HOT_PRESSURE,
  BROKER_LIMIT_REFRESH_SECONDS,
  EMPTY_BROKER_LIMIT_CONFIG,
  EMPTY_BROKER_LIMIT_STATE,
  LIMIT_FLAG_L0,
  LIMIT_FLAG_L1,
  LIMIT_FLAG_LG,
  brokerLimitId,
  brokerTradingLimitRowId,
  buildBrokerTradingLimitRow,
  computeBrokerLimitStatus,
  computeBrokerPressures,
  enabledWindows,
  foldPoolLimitFields,
  hasEnabledWindow,
  resetBrokerState,
  shouldRefreshBrokerState,
  type BrokerLimitConfig,
  type BrokerLimitState,
} from "../src/brokerTradingLimits.ts";

// Golden vectors: the limit IDs Aegis polls today (aegis/config.yaml), so a
// drift in the XOR keying shows up as a mismatch against the live alert plane
// rather than as silently empty dashboard rows.
const AUD_EXCHANGE =
  "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7";
const USDM_CHECKSUMMED = "0x765DE816845861e75A25fCA122bb6898B8B1282a";
const USDM = USDM_CHECKSUMMED.toLowerCase();
const AUDM = "0x7175504c455076f15c04a2f90a8e352281f492f9";
const AUD_USDM_LIMIT_ID =
  "0xd580d237231109e6a96d67d8520d890ae552e1bd7c43f0310aa0b49468fbbded";
const AUD_AUDM_LIMIT_ID =
  "0xd580d237231109e6a96d67d855253150245af6ab7a62ae692295e92e51be073e";

const KES_EXCHANGE =
  "0x89de88b8eb790de26f4649f543cb6893d93635c728ac857f0926e842fb0d298b";
const CKES = "0x456a3d042c0dbd3db53d5489e98dfb038553b0d0";
const KES_USDM_LIMIT_ID =
  "0x89de88b8eb790de26f4649f5359680855d6e5420728979de2b9d80da43bc01a1";
const KES_CKES_LIMIT_ID =
  "0x89de88b8eb790de26f4649f506a15597f53b88fa9d91d1f6e0ab13417e5e995b";

const CHAIN_ID = 42220;
const POOL_ID = "42220-0x1d013077b00b28038a3f1e7a29aba34e12e562e9";
const BIPOOL_MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";

function config(overrides: Partial<BrokerLimitConfig> = {}): BrokerLimitConfig {
  return { ...EMPTY_BROKER_LIMIT_CONFIG, ...overrides };
}

function state(overrides: Partial<BrokerLimitState> = {}): BrokerLimitState {
  return { ...EMPTY_BROKER_LIMIT_STATE, ...overrides };
}

/** The live AUD exchange today: LG only, both timesteps zero. */
const AUD_CONFIG = config({ flags: LIMIT_FLAG_LG, limitGlobal: 1597n });

function row(overrides: {
  token?: string;
  exchangeId?: string;
  config?: BrokerLimitConfig;
  configKnown?: boolean;
  state?: BrokerLimitState;
  stateKnown?: boolean;
  stateBlock?: bigint;
  stateTimestamp?: bigint;
}): BrokerTradingLimit {
  return buildBrokerTradingLimitRow({
    chainId: CHAIN_ID,
    exchangeId: overrides.exchangeId ?? AUD_EXCHANGE,
    exchangeProvider: BIPOOL_MANAGER,
    poolId: POOL_ID,
    token: overrides.token ?? AUDM,
    config: overrides.config ?? AUD_CONFIG,
    configKnown: overrides.configKnown ?? true,
    state: overrides.state ?? state({ netflowGlobal: -1596n }),
    stateKnown: overrides.stateKnown ?? true,
    stateBlock: overrides.stateBlock ?? 77_563_625n,
    stateTimestamp: overrides.stateTimestamp ?? 1_757_000_000n,
    blockNumber: 77_563_625n,
    blockTimestamp: 1_757_000_000n,
  });
}

describe("brokerLimitId", () => {
  it("reproduces the limit IDs Aegis polls for the AUD exchange", () => {
    assert.equal(brokerLimitId(AUD_EXCHANGE, USDM), AUD_USDM_LIMIT_ID);
    assert.equal(brokerLimitId(AUD_EXCHANGE, AUDM), AUD_AUDM_LIMIT_ID);
  });

  it("reproduces an unrelated exchange's limit IDs (cUSD/cKES)", () => {
    assert.equal(brokerLimitId(KES_EXCHANGE, USDM), KES_USDM_LIMIT_ID);
    assert.equal(brokerLimitId(KES_EXCHANGE, CKES), KES_CKES_LIMIT_ID);
  });

  it("is invariant to address checksumming", () => {
    assert.equal(
      brokerLimitId(AUD_EXCHANGE, USDM_CHECKSUMMED),
      brokerLimitId(AUD_EXCHANGE, USDM),
    );
  });

  it("emits a lowercase 66-character bytes32", () => {
    const id = brokerLimitId(AUD_EXCHANGE, USDM);
    assert.equal(id.length, 66);
    assert.equal(id, id.toLowerCase());
  });

  it("left-pads a limit ID whose leading bytes cancel out", () => {
    const id = brokerLimitId(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000",
    );
    assert.equal(
      id,
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("is an involution — XORing the limit ID back yields the exchange", () => {
    assert.equal(brokerLimitId(AUD_USDM_LIMIT_ID, USDM), AUD_EXCHANGE);
  });
});

describe("brokerTradingLimitRowId", () => {
  it("namespaces by chain and lowercases the token", () => {
    assert.equal(
      brokerTradingLimitRowId(CHAIN_ID, AUD_EXCHANGE, USDM_CHECKSUMMED),
      `${CHAIN_ID}-${AUD_EXCHANGE}-${USDM}`,
    );
  });
});

describe("enabledWindows", () => {
  it("decodes each flag bit independently", () => {
    const all = config({
      flags: LIMIT_FLAG_L0 | LIMIT_FLAG_L1 | LIMIT_FLAG_LG,
      limit0: 10n,
      limit1: 20n,
      limitGlobal: 30n,
    });
    assert.deepEqual(enabledWindows(all), { l0: true, l1: true, lg: true });
    assert.deepEqual(enabledWindows({ ...all, flags: LIMIT_FLAG_L0 }), {
      l0: true,
      l1: false,
      lg: false,
    });
    assert.deepEqual(enabledWindows({ ...all, flags: LIMIT_FLAG_L1 }), {
      l0: false,
      l1: true,
      lg: false,
    });
    assert.deepEqual(enabledWindows({ ...all, flags: LIMIT_FLAG_LG }), {
      l0: false,
      l1: false,
      lg: true,
    });
  });

  it("treats a flagged window with a zero limit as disabled", () => {
    const flagged = config({
      flags: LIMIT_FLAG_L0 | LIMIT_FLAG_L1 | LIMIT_FLAG_LG,
    });
    assert.deepEqual(enabledWindows(flagged), {
      l0: false,
      l1: false,
      lg: false,
    });
    assert.equal(hasEnabledWindow(flagged), false);
  });

  it("treats a positive limit with no flag as disabled", () => {
    assert.equal(
      hasEnabledWindow(config({ flags: 0, limitGlobal: 1597n })),
      false,
    );
  });
});

describe("computeBrokerPressures", () => {
  it("scores the live AUD legs from their absolute netflow", () => {
    const audm = computeBrokerPressures(
      AUD_CONFIG,
      state({ netflowGlobal: -1596n }),
    );
    assert.equal(audm.pGlobal.toFixed(4), "0.9994");
    assert.equal(audm.worst, audm.pGlobal);

    const usdm = computeBrokerPressures(
      config({ flags: LIMIT_FLAG_LG, limitGlobal: 1144n }),
      state({ netflowGlobal: 1139n }),
    );
    assert.equal(usdm.pGlobal.toFixed(4), "0.9956");
  });

  it("returns 0 for a zero limit instead of NaN or Infinity", () => {
    const pressures = computeBrokerPressures(
      config({ flags: LIMIT_FLAG_LG }),
      state({ netflowGlobal: 500n }),
    );
    assert.equal(pressures.pGlobal, 0);
    assert.equal(Number.isFinite(pressures.worst), true);
  });

  it("scores only enabled windows", () => {
    const pressures = computeBrokerPressures(
      config({
        flags: LIMIT_FLAG_L0,
        limit0: 100n,
        limit1: 100n,
        limitGlobal: 100n,
      }),
      state({ netflow0: 50n, netflow1: 90n, netflowGlobal: 99n }),
    );
    assert.equal(pressures.p0, 0.5);
    assert.equal(pressures.p1, 0);
    assert.equal(pressures.pGlobal, 0);
    assert.equal(pressures.worst, 0.5);
  });
});

describe("computeBrokerLimitStatus", () => {
  const known = (netflowGlobal: bigint, limitGlobal = 1597n): string =>
    computeBrokerLimitStatus(
      config({ flags: LIMIT_FLAG_LG, limitGlobal }),
      state({ netflowGlobal }),
      true,
      true,
    );

  it("shares the FPMM WARN threshold", () => {
    assert.equal(BROKER_LIMIT_HOT_PRESSURE, 0.8);
  });

  it("escalates at the FPMM thresholds", () => {
    assert.equal(known(-1596n), "WARN");
    assert.equal(known(1597n), "CRITICAL");
    assert.equal(known(1598n), "CRITICAL");
    // 0.8 × 1597 = 1277.6, so 1278 is the first netflow at or above WARN.
    assert.equal(known(1278n), "WARN");
    assert.equal(known(1277n), "OK");
    assert.equal(known(0n), "OK");
  });

  it("stays N/A until both halves of the row are known", () => {
    const cfg = config({ flags: LIMIT_FLAG_LG, limitGlobal: 1597n });
    const st = state({ netflowGlobal: 1597n });
    assert.equal(computeBrokerLimitStatus(cfg, st, false, true), "N/A");
    assert.equal(computeBrokerLimitStatus(cfg, st, true, false), "N/A");
    assert.equal(computeBrokerLimitStatus(cfg, st, false, false), "N/A");
  });

  it("stays N/A when no window is enabled", () => {
    assert.equal(known(500n, 0n), "N/A");
  });
});

describe("resetBrokerState", () => {
  const priorState = state({
    lastUpdated0: 111n,
    lastUpdated1: 222n,
    netflow0: 10n,
    netflow1: 20n,
    netflowGlobal: 30n,
  });

  it("restarts both window clocks", () => {
    const next = resetBrokerState(priorState, config({ flags: 7 }));
    assert.equal(next.lastUpdated0, 0n);
    assert.equal(next.lastUpdated1, 0n);
  });

  it("keeps the netflow of every still-flagged window", () => {
    const next = resetBrokerState(
      priorState,
      config({ flags: LIMIT_FLAG_L0 | LIMIT_FLAG_L1 | LIMIT_FLAG_LG }),
    );
    assert.equal(next.netflow0, 10n);
    assert.equal(next.netflow1, 20n);
    assert.equal(next.netflowGlobal, 30n);
  });

  it("zeroes the netflow of every unflagged window", () => {
    assert.deepEqual(resetBrokerState(priorState, config({ flags: 0 })), {
      lastUpdated0: 0n,
      lastUpdated1: 0n,
      netflow0: 0n,
      netflow1: 0n,
      netflowGlobal: 0n,
    });
  });

  it("zeroes each window independently", () => {
    const keepL0 = resetBrokerState(
      priorState,
      config({ flags: LIMIT_FLAG_L0 }),
    );
    assert.deepEqual(
      [keepL0.netflow0, keepL0.netflow1, keepL0.netflowGlobal],
      [10n, 0n, 0n],
    );
    const keepL1 = resetBrokerState(
      priorState,
      config({ flags: LIMIT_FLAG_L1 }),
    );
    assert.deepEqual(
      [keepL1.netflow0, keepL1.netflow1, keepL1.netflowGlobal],
      [0n, 20n, 0n],
    );
    const keepLg = resetBrokerState(
      priorState,
      config({ flags: LIMIT_FLAG_LG }),
    );
    assert.deepEqual(
      [keepLg.netflow0, keepLg.netflow1, keepLg.netflowGlobal],
      [0n, 0n, 30n],
    );
  });

  it("ignores the limit value — the contract gates on the flag alone", () => {
    const next = resetBrokerState(
      priorState,
      config({ flags: LIMIT_FLAG_LG, limitGlobal: 0n }),
    );
    assert.equal(next.netflowGlobal, 30n);
  });

  it("starts from zero when no prior state exists", () => {
    assert.deepEqual(
      resetBrokerState(undefined, config({ flags: 7 })),
      EMPTY_BROKER_LIMIT_STATE,
    );
  });
});

describe("shouldRefreshBrokerState", () => {
  const BLOCK = 100n;
  const NOW = 1_757_000_000n;
  const fresh = row({
    stateBlock: 90n,
    stateTimestamp: NOW,
    state: state({ netflowGlobal: 100n }),
    config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 1597n }),
  });

  it("refreshes when no row exists", () => {
    assert.equal(shouldRefreshBrokerState(undefined, BLOCK, NOW), true);
  });

  it("skips a row already read at or after this block", () => {
    assert.equal(
      shouldRefreshBrokerState({ ...fresh, stateBlock: BLOCK }, BLOCK, NOW),
      false,
    );
    assert.equal(
      shouldRefreshBrokerState(
        { ...fresh, stateBlock: BLOCK + 1n },
        BLOCK,
        NOW,
      ),
      false,
    );
  });

  it("keeps the same-block guard ahead of every other reason", () => {
    const stale = {
      ...fresh,
      stateBlock: BLOCK,
      stateTimestamp: 0n,
      configKnown: false,
      stateKnown: false,
    };
    assert.equal(shouldRefreshBrokerState(stale, BLOCK, NOW), false);
  });

  it("refreshes an unknown config or an unknown state", () => {
    assert.equal(
      shouldRefreshBrokerState({ ...fresh, configKnown: false }, BLOCK, NOW),
      true,
    );
    assert.equal(
      shouldRefreshBrokerState({ ...fresh, stateKnown: false }, BLOCK, NOW),
      true,
    );
  });

  it("refreshes once the stored state reaches the refresh window", () => {
    const at = NOW + BROKER_LIMIT_REFRESH_SECONDS;
    assert.equal(shouldRefreshBrokerState(fresh, BLOCK, at), true);
    assert.equal(shouldRefreshBrokerState(fresh, BLOCK, at - 1n), false);
  });

  it("refreshes on every swap once a window is hot", () => {
    const hot = row({
      stateBlock: 90n,
      stateTimestamp: NOW,
      state: state({ netflowGlobal: 1278n }),
    });
    assert.equal(shouldRefreshBrokerState(hot, BLOCK, NOW), true);
    const warm = row({
      stateBlock: 90n,
      stateTimestamp: NOW,
      state: state({ netflowGlobal: 1200n }),
    });
    assert.equal(shouldRefreshBrokerState(warm, BLOCK, NOW), false);
  });
});

describe("buildBrokerTradingLimitRow", () => {
  it("carries the limit ID, lowercased token and 4dp pressures", () => {
    const built = row({ token: "0x7175504C455076F15c04A2F90a8e352281F492F9" });
    assert.equal(built.id, `${CHAIN_ID}-${AUD_EXCHANGE}-${AUDM}`);
    assert.equal(built.token, AUDM);
    assert.equal(built.limitId, AUD_AUDM_LIMIT_ID);
    assert.equal(built.limitPressure0, "0.0000");
    assert.equal(built.limitPressure1, "0.0000");
    assert.equal(built.limitPressureGlobal, "0.9994");
    assert.equal(built.limitStatus, "WARN");
    assert.equal(built.poolId, POOL_ID);
  });

  it("keeps the serialized pressure and the status on the same side of a threshold", () => {
    // 799_960/1_000_000 is 0.79996 exactly: it rounds up to "0.8000" at the
    // stored 4dp, so the status must read WARN too. An unrounded status would
    // pair an amber bar with an OK badge here, and a red bar with WARN at 1.0.
    const rounded = row({
      config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 1_000_000n }),
      state: state({ netflowGlobal: 799_960n }),
    });
    assert.equal(rounded.limitPressureGlobal, "0.8000");
    assert.equal(rounded.limitStatus, "WARN");

    const breaching = row({
      config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 1_000_000n }),
      state: state({ netflowGlobal: 999_960n }),
    });
    assert.equal(breaching.limitPressureGlobal, "1.0000");
    assert.equal(breaching.limitStatus, "CRITICAL");
  });

  it("writes an N/A placeholder when neither half is known", () => {
    const placeholder = row({
      config: EMPTY_BROKER_LIMIT_CONFIG,
      configKnown: false,
      state: EMPTY_BROKER_LIMIT_STATE,
      stateKnown: false,
      stateBlock: 0n,
      stateTimestamp: 0n,
    });
    assert.equal(placeholder.limitStatus, "N/A");
    assert.equal(placeholder.stateBlock, 0n);
    assert.equal(placeholder.limitPressureGlobal, "0.0000");
  });
});

describe("foldPoolLimitFields", () => {
  const pool = { token0: USDM_CHECKSUMMED, token1: AUDM };
  const usdmRow = row({
    token: USDM,
    config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 1144n }),
    state: state({ netflowGlobal: 1139n }),
  });
  const audmRow = row({ token: AUDM });

  it("maps each leg onto its own per-token pressure slot", () => {
    assert.deepEqual(foldPoolLimitFields([audmRow, usdmRow], pool), {
      limitStatus: "WARN",
      limitPressure0: "0.9956",
      limitPressure1: "0.9994",
    });
  });

  it("matches tokens case-insensitively", () => {
    const folded = foldPoolLimitFields([usdmRow, audmRow], {
      token0: USDM.toUpperCase(),
      token1: AUDM,
    });
    assert.equal(folded.limitPressure0, "0.9956");
  });

  it("takes the worst status across the legs", () => {
    const breached = row({
      token: AUDM,
      state: state({ netflowGlobal: 1597n }),
    });
    assert.equal(
      foldPoolLimitFields([usdmRow, breached], pool).limitStatus,
      "CRITICAL",
    );
    const calm = row({ token: AUDM, state: state({ netflowGlobal: 1n }) });
    const calmUsdm = row({
      token: USDM,
      config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 1144n }),
      state: state({ netflowGlobal: 1n }),
    });
    assert.equal(foldPoolLimitFields([calm, calmUsdm], pool).limitStatus, "OK");
  });

  it("reports N/A when no leg has both its config and its state", () => {
    const unknown = row({ token: AUDM, configKnown: false });
    const pending = row({ token: USDM, stateKnown: false });
    assert.deepEqual(foldPoolLimitFields([unknown, pending], pool), {
      limitStatus: "N/A",
      limitPressure0: "0.0000",
      limitPressure1: "0.0000",
    });
    assert.deepEqual(foldPoolLimitFields([], pool), {
      limitStatus: "N/A",
      limitPressure0: "0.0000",
      limitPressure1: "0.0000",
    });
  });

  it("reports N/A when the pool has not mirrored its tokens yet", () => {
    const breached = row({
      token: AUDM,
      state: state({ netflowGlobal: 1597n }),
    });
    for (const tokenless of [
      { token0: undefined, token1: AUDM },
      { token0: USDM, token1: undefined },
      { token0: undefined, token1: undefined },
    ]) {
      assert.deepEqual(foldPoolLimitFields([usdmRow, breached], tokenless), {
        limitStatus: "N/A",
        limitPressure0: "0.0000",
        limitPressure1: "0.0000",
      });
    }
  });

  it("reports N/A when a leg is not one of the pool's tokens", () => {
    const folded = foldPoolLimitFields([audmRow], {
      token0: USDM,
      token1: CKES,
    });
    assert.deepEqual(folded, {
      limitStatus: "N/A",
      limitPressure0: "0.0000",
      limitPressure1: "0.0000",
    });
  });

  it("reports N/A while only one pool leg is known", () => {
    // A per-leg RPC read can succeed for token0 and fail for token1. Folding
    // the readable leg alone would publish OK/WARN next to a 0.00% slot that
    // is really "unread", so neither may reach the pool until both land.
    const pendingAudm = row({ token: AUDM, stateKnown: false });
    for (const rows of [[usdmRow], [usdmRow, pendingAudm]]) {
      assert.deepEqual(foldPoolLimitFields(rows, pool), {
        limitStatus: "N/A",
        limitPressure0: "0.0000",
        limitPressure1: "0.0000",
      });
    }
  });

  it("folds a known leg with no enabled window to N/A", () => {
    const noWindow = row({
      token: AUDM,
      config: config({ flags: LIMIT_FLAG_LG, limitGlobal: 0n }),
    });
    assert.equal(foldPoolLimitFields([noWindow], pool).limitStatus, "N/A");
  });
});
