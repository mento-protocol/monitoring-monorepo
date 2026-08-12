import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(
  new URL("./europ-operational-admission-proof.sh", import.meta.url),
);
const source = readFileSync(runnerPath, "utf8");

test("EUROP proof runner is syntax-valid shell", () => {
  const result = spawnSync("bash", ["-n", runnerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("EUROP proof runner rejects missing or caller-supplied execution endpoints before starting Anvil", () => {
  const missingSource = spawnSync("bash", [runnerPath], {
    encoding: "utf8",
    env: { ...process.env, POLYGON_RPC_URL: "" },
  });
  assert.equal(missingSource.status, 2);
  assert.match(missingSource.stderr, /POLYGON_RPC_URL is required/u);

  const callerExecutionEndpoint = spawnSync("bash", [runnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      POLYGON_RPC_URL: "https://polygon-rpc.example",
      EXECUTION_RPC_URL: "https://execution.example",
    },
  });
  assert.equal(callerExecutionEndpoint.status, 2);
  assert.match(
    callerExecutionEndpoint.stderr,
    /do not set an execution RPC URL/u,
  );

  const credentialedSource = new URL("https://polygon-rpc.example");
  credentialedSource.username = "u";
  credentialedSource.password = "p";
  for (const localSource of [
    "http://localhost",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.1",
    credentialedSource.toString(),
  ]) {
    const result = spawnSync("bash", [runnerPath], {
      encoding: "utf8",
      env: { ...process.env, POLYGON_RPC_URL: localSource },
    });
    assert.equal(result.status, 2, localSource);
    assert.match(result.stderr, /remote HTTPS hostname/u, localSource);
  }
});

test("EUROP proof runner pins a fresh localhost Polygon fork before every mutation", () => {
  assert.match(source, /proof_chain_id="137"/u);
  assert.match(source, /proof_fork_block="91830875"/u);
  assert.match(
    source,
    /proof_fork_hash="0x3f7cc53580045d0e9c7e862406891a9e152b7b2c47b0eeed1b73bcebe214af25"/u,
  );
  assert.match(source, /proof_witness_port="8552"/u);
  assert.match(source, /proof_halt_port="8553"/u);
  assert.match(source, /--host 127\.0\.0\.1/u);
  assert.match(source, /--quiet/u);
  assert.match(source, /proof_rpc="http:\/\/127\.0\.0\.1:\$port"/u);
  assert.match(source, /--fork-url "\$POLYGON_RPC_URL"/u);
  assert.match(source, /--fork-block-number "\$proof_fork_block"/u);
  assert.match(source, /verify_fresh_fork "\$scenario"/u);
  assert.match(source, /kill -0 "\$proof_anvil_pid"/u);
  assert.match(source, /web3_clientVersion/u);
  assert.match(source, /eth_chainId/u);
  assert.match(source, /eth_getBlockByNumber/u);
  const witnessBody = source.slice(
    source.indexOf("run_witness_scenario() {"),
    source.indexOf("run_halt_scenario() {"),
  );
  const haltBody = source.slice(source.indexOf("run_halt_scenario() {"));
  assert.ok(
    witnessBody.indexOf('start_fresh_fork "witness"') <
      witnessBody.indexOf("prepare_witness_seed"),
    "the witness must start and verify its fork before the local seed",
  );
  assert.ok(
    haltBody.indexOf('start_fresh_fork "halt"') <
      haltBody.indexOf("anvil_impersonateAccount"),
    "the halt proof must start and verify its fork before Safe impersonation",
  );
});

test("EUROP proof runner owns its execution endpoint and never embeds signing material", () => {
  assert.match(
    source,
    /POLYGON_RPC_URL is required as the read-only Polygon fork source/u,
  );
  assert.match(source, /do not set an execution RPC URL/u);
  assert.match(source, /--unlocked --from "\$sender"/u);
  assert.doesNotMatch(source, /private-key/iu);
  assert.doesNotMatch(source, /(?:PROOF_|proof_)?(?:PRIVATE|SIGNING)_KEY\s*=/u);
  assert.doesNotMatch(
    source,
    /\$\{[^}]+,,\}/u,
    "the runner must remain Bash 3.2-compatible",
  );
  assert.match(source, /trap cleanup EXIT INT TERM/u);
  assert.match(source, /\.tmp\/europ-operational-admission-proof/u);
});

test("EUROP witness has fixed arithmetic, ordered local seed checks, and deterministic time", () => {
  for (const expected of [
    'proof_cycles="51"',
    'proof_europ_input_per_cycle="2000000000"',
    'proof_eurm_output_per_cycle="1999000000000000000000"',
    'proof_expected_external_eurm="101949000000000000000000"',
    'proof_budget_eurm="100000000000000000000000"',
    'proof_europ_total_supply_slot="0x00000000000000000000000000000000000000000000000000000000000000cb"',
  ]) {
    assert.ok(
      source.includes(expected),
      `missing fixed proof input: ${expected}`,
    );
  }
  assert.match(source, /EUROP balance slot does not match balanceOf getter/u);
  assert.match(
    source,
    /EUROP total-supply slot does not match totalSupply getter/u,
  );
  assert.match(source, /pool EUROP changed during local seed/u);
  assert.match(source, /anvil_setStorageAt/u);
  assert.match(source, /evm_setNextBlockTimestamp/u);
  assert.match(source, /receipt_count" == "153"/u);
  assert.match(source, /elapsed" == "15080"/u);
  assert.match(source, /write_receipt_manifest/u);
  assert.match(source, /write_artifact_manifest/u);
  assert.match(source, /proof_transactions_file/u);
  assert.match(source, /eth_getTransactionByHash/u);
  assert.match(source, /transactions\.jsonl/u);
  assert.match(source, /transactionsSha256/u);
  assert.match(source, /blockTimestamp/u);
  assert.match(source, /"transfer"/u);
  assert.match(source, /"swap"/u);
  assert.match(source, /"reserve-rebalance"/u);
  assert.match(source, /proof_witness_model/u);
  assert.match(source, /proof_mento_core_commit/u);
  assert.match(source, /productionActivity:false/u);
  assert.match(source, /claimStatus:"unattested"/u);
  assert.match(source, /provenance:"unattested"/u);
  assert.match(
    source,
    /for artifact in swap-revert\.txt open-rebalance-revert\.txt reserve-rebalance-revert\.txt/u,
  );
  assert.match(source, /receiptsSha256/u);
  assert.match(source, /initialTraderEurmRaw/u);
  assert.match(source, /finalTraderEuropRaw/u);
  assert.match(source, /initialPoolEurmRaw/u);
  assert.match(source, /finalSupplyRaw/u);
  const seedBody = source.slice(
    source.indexOf("prepare_witness_seed() {"),
    source.indexOf("expect_trading_suspended() {"),
  );
  assert.ok(
    seedBody.indexOf("EUROP balance slot does not match balanceOf getter") <
      seedBody.indexOf("anvil_setStorageAt"),
    "getter/storage checks must appear before the local seed writes",
  );
});

test("EUROP halt proof fixes the exact report, validates all halted paths, and restores quoting", () => {
  assert.match(source, /proof_halt_rate="994000000000000000000000"/u);
  assert.match(source, /proof_normal_rate="1000000000000000000000000"/u);
  assert.match(source, /proof_rate_denominator="1000000000000000000000000"/u);
  assert.match(source, /proof_trading_suspended_selector="0x4ac30c22"/u);
  assert.match(source, /"halt-report"/u);
  assert.match(source, /"restore-report"/u);
  assert.match(source, /--arg controlSafe "\$proof_safe"/u);
  assert.match(source, /--arg sortedOracles "\$proof_sorted_oracles"/u);
  assert.match(
    source,
    /halt_rate_json="\$\(cast call[^\n]+medianRate\(address\)\(uint256,uint256\)[^\n]+\)"/u,
  );
  assert.match(source, /observed_halt_rate" == "\$proof_halt_rate"/u);
  assert.match(
    source,
    /observed_halt_denominator" == "\$proof_rate_denominator"/u,
  );
  assert.match(
    source,
    /restored_rate_json="\$\(cast call[^\n]+medianRate\(address\)\(uint256,uint256\)[^\n]+\)"/u,
  );
  assert.match(source, /observed_restored_rate" == "\$proof_normal_rate"/u);
  assert.match(
    source,
    /observed_restored_denominator" == "\$proof_rate_denominator"/u,
  );
  assert.match(source, /--arg haltRateRaw "\$observed_halt_rate"/u);
  assert.match(source, /--arg restoredRateRaw "\$observed_restored_rate"/u);
  assert.ok(
    source.includes(
      'grep -Eq "data: \\"?${proof_trading_suspended_selector}\\"?$"',
    ),
  );
  assert.match(
    source,
    /expect_trading_suspended "swap" cast call[^\n]+\n?[^\n]*'swap\(uint256,uint256,address,bytes\)'/u,
  );
  assert.doesNotMatch(
    source,
    /expect_trading_suspended "swap" cast call[^\n]+\n?[^\n]*'getAmountOut\(uint256,address\)'/u,
  );
  assert.match(source, /expect_trading_suspended "open-rebalance" cast call/u);
  assert.match(
    source,
    /expect_trading_suspended "reserve-rebalance" cast call/u,
  );
  assert.match(source, /restored_quote" == "\$healthy_quote"/u);
  assert.match(source, /receipt_count" == "2"/u);
});

test("EUROP proof runner labels its output as an unattested local diagnostic", () => {
  assert.match(source, /EUROP local-fork diagnostic completed/u);
  assert.match(source, /unattested local diagnostics/u);
  assert.doesNotMatch(source, /local signature|local token/iu);
});
