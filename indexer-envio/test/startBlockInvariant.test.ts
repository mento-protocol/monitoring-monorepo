/// <reference types="mocha" />
import { strict as assert } from "assert";
import {
  assertStartBlocksValid,
  FPMM_FIRST_DEPLOY_BLOCK,
  START_BLOCK_ENV_NAME,
} from "../src/EventHandlers";

// Chain IDs used in tests (mainnet only — startup guard only covers mainnet)
const CELO = 42220;
const MONAD = 143;

describe("assertStartBlocksValid", () => {
  it("passes when no env overrides are set", () => {
    assert.doesNotThrow(() => assertStartBlocksValid({}));
  });

  it("passes when overrides are undefined or empty string", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({
        [CELO]: undefined,
        [MONAD]: "",
      }),
    );
  });

  it("passes when start block equals first deploy block", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({
        [CELO]: String(FPMM_FIRST_DEPLOY_BLOCK[CELO]),
        [MONAD]: String(FPMM_FIRST_DEPLOY_BLOCK[MONAD]),
      }),
    );
  });

  it("passes when start block is below first deploy block", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({
        [CELO]: String(FPMM_FIRST_DEPLOY_BLOCK[CELO] - 1),
      }),
    );
  });

  it("warns (does not throw) when start block is too high in non-strict mode", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[CELO] + 1;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      assert.doesNotThrow(() =>
        assertStartBlocksValid({ [CELO]: String(tooHigh) }, false),
      );
      assert.equal(warnings.length, 1);
      assert(warnings[0].includes(START_BLOCK_ENV_NAME[CELO]));
      assert(warnings[0].includes(String(tooHigh)));
    } finally {
      console.warn = origWarn;
    }
  });

  it("throws when start block is too high in strict mode", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[CELO] + 1;
    assert.throws(
      () => assertStartBlocksValid({ [CELO]: String(tooHigh) }, true),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[CELO]));
        assert(err.message.includes(String(tooHigh)));
        assert(err.message.includes(String(FPMM_FIRST_DEPLOY_BLOCK[CELO])));
        return true;
      },
    );
  });

  it("throws for Monad in strict mode with correct env var name", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[MONAD] + 1000;
    assert.throws(
      () => assertStartBlocksValid({ [MONAD]: String(tooHigh) }, true),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[MONAD]));
        return true;
      },
    );
  });

  it("skips non-numeric override gracefully (no throw)", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({ [CELO]: "not-a-number" }),
    );
  });

  it("does not throw for testnet env vars set to high values (mainnet guard is mainnet-only)", () => {
    // Regression: a leftover ENVIO_START_BLOCK_MONAD_TESTNET in .env from a
    // prior testnet run must NOT block a mainnet startup. The guard is scoped
    // to mainnet chains only — testnet vars are outside FPMM_FIRST_DEPLOY_BLOCK.
    assert.doesNotThrow(() =>
      // Pass testnet chain IDs — they're not in FPMM_FIRST_DEPLOY_BLOCK,
      // so the loop simply has no entry for them and does nothing.
      assertStartBlocksValid({ 10143: "99999999", 11142220: "99999999" }),
    );
  });
});
