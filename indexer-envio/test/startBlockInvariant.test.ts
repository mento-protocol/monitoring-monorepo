/// <reference types="mocha" />
import { strict as assert } from "assert";
import {
  assertStartBlocksValid,
  FPMM_FIRST_DEPLOY_BLOCK,
  START_BLOCK_ENV_NAME,
} from "../src/EventHandlers";

// Chain IDs used in tests
const CELO = 42220;
const MONAD = 143;
const CELO_SEPOLIA = 11142220;
const MONAD_TESTNET = 10143;

describe("assertStartBlocksValid", () => {
  it("passes when no env overrides are set", () => {
    assert.doesNotThrow(() => assertStartBlocksValid({}));
  });

  it("passes when overrides are undefined or empty string", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({
        [CELO]: undefined,
        [MONAD]: "",
        [CELO_SEPOLIA]: undefined,
        [MONAD_TESTNET]: "",
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

  it("throws when Celo start block is above first deploy block", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[CELO] + 1;
    assert.throws(
      () => assertStartBlocksValid({ [CELO]: String(tooHigh) }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[CELO]));
        assert(err.message.includes(String(tooHigh)));
        assert(err.message.includes(String(FPMM_FIRST_DEPLOY_BLOCK[CELO])));
        return true;
      },
    );
  });

  it("throws when Monad start block is above first deploy block", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[MONAD] + 1000;
    assert.throws(
      () => assertStartBlocksValid({ [MONAD]: String(tooHigh) }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[MONAD]));
        return true;
      },
    );
  });

  it("throws for Celo Sepolia with correct env var name in message", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[CELO_SEPOLIA] + 1;
    assert.throws(
      () => assertStartBlocksValid({ [CELO_SEPOLIA]: String(tooHigh) }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[CELO_SEPOLIA]));
        assert(!err.message.includes("ENVIO_START_BLOCK_CELO\n")); // not the mainnet var
        return true;
      },
    );
  });

  it("throws for Monad testnet with correct env var name in message", () => {
    const tooHigh = FPMM_FIRST_DEPLOY_BLOCK[MONAD_TESTNET] + 1;
    assert.throws(
      () => assertStartBlocksValid({ [MONAD_TESTNET]: String(tooHigh) }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert(err.message.includes(START_BLOCK_ENV_NAME[MONAD_TESTNET]));
        return true;
      },
    );
  });

  it("skips non-numeric override gracefully (no throw)", () => {
    assert.doesNotThrow(() =>
      assertStartBlocksValid({ [CELO]: "not-a-number" }),
    );
  });

  it("does not throw for a valid Celo Sepolia value that would be > Monad testnet deploy block", () => {
    // Regression: ENVIO_START_BLOCK=18901381 is valid for Celo Sepolia but
    // > 17932599 (Monad testnet first deploy). Must NOT throw for the wrong chain.
    const celoSepoliaDevStart = 18901381;
    assert(celoSepoliaDevStart > FPMM_FIRST_DEPLOY_BLOCK[MONAD_TESTNET]);
    assert.doesNotThrow(() =>
      assertStartBlocksValid({ [CELO_SEPOLIA]: String(celoSepoliaDevStart) }),
    );
  });
});
