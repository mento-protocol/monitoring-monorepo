#!/usr/bin/env bash
# Runs two localhost-only diagnostics for the EUROP admission record.
#
# This script never signs or broadcasts to Polygon. POLYGON_RPC_URL is only a
# read source for Anvil; every mutation and transaction targets a fresh,
# localhost-only Anvil process started here.
set -Eeuo pipefail

# Foundry nightly builds otherwise repeat this warning for every Cast call.
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

if [[ $# -ne 0 ]]; then
  echo "usage: POLYGON_RPC_URL=https://... bash scripts/europ-operational-admission-proof.sh" >&2
  exit 2
fi

if [[ -z "${POLYGON_RPC_URL:-}" ]]; then
  echo "error: POLYGON_RPC_URL is required as the read-only Polygon fork source" >&2
  exit 2
fi

# A second endpoint would make it ambiguous where mutations run. The runner
# owns its execution endpoint and rejects attempts to supply one.
if [[ -n "${EXECUTION_RPC_URL:-}" || -n "${PROOF_EXECUTION_RPC_URL:-}" ]]; then
  echo "error: this runner owns execution on fresh localhost Anvil forks; do not set an execution RPC URL" >&2
  exit 2
fi

if ! node -e '
  const { isIP } = require("node:net");
  let url;
  try {
    url = new URL(process.argv[1]);
  } catch {
    process.exit(1);
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const localName =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    hostname === "" ||
    localName ||
    isIP(hostname) !== 0
  ) {
    process.exit(1);
  }
' "$POLYGON_RPC_URL"; then
  echo "error: POLYGON_RPC_URL must use a remote HTTPS hostname without embedded credentials" >&2
  exit 2
fi

for proof_command in anvil cast jq node shasum nc; do
  command -v "$proof_command" >/dev/null 2>&1 || {
    echo "error: required command not found: $proof_command" >&2
    exit 2
  }
done

proof_repo_root="$(git rev-parse --show-toplevel)"
proof_output_root="$proof_repo_root/.tmp/europ-operational-admission-proof"
mkdir -p "$proof_output_root"
proof_run_dir="$(mktemp -d "$proof_output_root/run.XXXXXXXX")"

proof_chain_id="137"
proof_fork_block="91830875"
proof_fork_hash="0x3f7cc53580045d0e9c7e862406891a9e152b7b2c47b0eeed1b73bcebe214af25"
proof_witness_port="8552"
proof_halt_port="8553"
proof_start_timestamp="1786451400"
proof_response_seconds="21600"

proof_pool="0xCd8C6811d975981F57E7fB32e59f0BeE66aF3201"
proof_eurm="0x4D502d735B4C574B487Ed641ae87cEaE884731C7"
proof_europ="0x888883b5F5D21fb10Dfeb70e8f9722B9FB0E5E51"
proof_open_strategy="0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f"
proof_reserve_strategy="0xa0fB8b16ce6AF3634fF9F3f4F40E49E1C1ae4f0B"
proof_safe="0x58099B74F4ACd642Da77b4B7966b4138ec5Ba458"
proof_sorted_oracles="0x6f92C745346057a61b259579256159458a0a6A92"
proof_breaker_box="0x9fc1E0d10fb38954Da385B8B25aB2BbaF3241722"
proof_feed="0xc22418a83DfC262B10a1f57E25309DB83E7eA79e"
proof_zero="0x0000000000000000000000000000000000000000"

# This is Anvil's first unlocked development account. It is used only on the
# process started by this script; no signing material is supplied to Cast.
proof_trader="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# Storage locations were checked against the ERC-20 getters before any local
# write. The witness seeds only this local account's EUROP balance and matching
# total supply; it never changes pool storage.
proof_europ_balance_slot="0x60d9306e205976af7394daf1199228fbe24704f9030af127fa8c5e3e867e5ead"
proof_europ_total_supply_slot="0x00000000000000000000000000000000000000000000000000000000000000cb"
proof_seed_europ="102000000000"
proof_cycles="51"
proof_europ_input_per_cycle="2000000000"
proof_eurm_output_per_cycle="1999000000000000000000"
proof_witness_model="europ-reserve-rebalance-51-cycle-v1"
proof_mento_core_commit="07ecf3df5650a33ea6957f1ad2966e02c5082253"
proof_expected_external_eurm="101949000000000000000000"
proof_budget_eurm="100000000000000000000000"
proof_cycle_seconds="301"

proof_halt_rate="994000000000000000000000"
proof_normal_rate="1000000000000000000000000"
proof_rate_denominator="1000000000000000000000000"
proof_trading_suspended_selector="0x4ac30c22"

proof_anvil_pid=""
proof_rpc=""
proof_scenario_dir=""
proof_receipts_file=""
proof_transactions_file=""
proof_trace_sequence="0"
proof_last_timestamp=""

fail() {
  echo "error: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$proof_anvil_pid" ]] && kill -0 "$proof_anvil_pid" 2>/dev/null; then
    kill "$proof_anvil_pid" 2>/dev/null || true
    wait "$proof_anvil_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

uint_to_bytes32() {
  # The template expression belongs to Node, not the shell.
  # shellcheck disable=SC2016
  node -e 'process.stdout.write(`0x${BigInt(process.argv[1]).toString(16).padStart(64, "0")}`)' "$1"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

uint_greater_than() {
  node -e 'process.exit(BigInt(process.argv[1]) > BigInt(process.argv[2]) ? 0 : 1)' "$1" "$2"
}

read_uint() {
  cast call --rpc-url "$proof_rpc" --json "$1" "$2" "${@:3}" | jq -er '.[0] | tostring'
}

read_block_timestamp() {
  local block_number="$1"
  local timestamp_hex
  timestamp_hex="$(cast rpc --rpc-url "$proof_rpc" eth_getBlockByNumber "$block_number" false | jq -er '.timestamp')"
  cast to-dec "$timestamp_hex"
}

require_free_local_port() {
  local port="$1"
  if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
    fail "refusing to use occupied localhost port $port"
  fi
}

wait_for_fork_rpc() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if ! kill -0 "$proof_anvil_pid" 2>/dev/null; then
      wait "$proof_anvil_pid" 2>/dev/null || true
      fail "owned Anvil process exited before its RPC became ready; see $proof_scenario_dir/anvil.log"
    fi
    if cast rpc --rpc-url "$proof_rpc" eth_chainId >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Anvil did not become ready; see $proof_scenario_dir/anvil.log"
}

verify_fresh_fork() {
  local scenario="$1"
  local client_version
  local chain_id
  local latest_number_hex
  local latest_number
  local latest_hash

  kill -0 "$proof_anvil_pid" 2>/dev/null || fail "$scenario owned Anvil process is not alive"
  [[ "$proof_rpc" == "http://127.0.0.1:"* ]] || fail "execution endpoint is not localhost"
  client_version="$(cast rpc --rpc-url "$proof_rpc" web3_clientVersion | jq -er 'strings')"
  [[ "$(lowercase "$client_version")" == *anvil* ]] || fail "$scenario endpoint is not Anvil: $client_version"
  chain_id="$(cast rpc --rpc-url "$proof_rpc" eth_chainId | jq -er 'strings')"
  [[ "$chain_id" == "0x89" ]] || fail "$scenario fork chain id is $chain_id, expected 0x89"
  latest_number_hex="$(cast rpc --rpc-url "$proof_rpc" eth_blockNumber | jq -er 'strings')"
  latest_number="$(cast to-dec "$latest_number_hex")"
  [[ "$latest_number" == "$proof_fork_block" ]] || fail "$scenario fork is not fresh at block $proof_fork_block"
  latest_hash="$(cast rpc --rpc-url "$proof_rpc" eth_getBlockByNumber "$latest_number_hex" false | jq -er '.hash')"
  [[ "$(lowercase "$latest_hash")" == "$proof_fork_hash" ]] || fail "$scenario fork hash does not match the pinned Polygon block"
  kill -0 "$proof_anvil_pid" 2>/dev/null || fail "$scenario owned Anvil process exited during verification"
}

start_fresh_fork() {
  local scenario="$1"
  local port="$2"
  require_free_local_port "$port"
  proof_scenario_dir="$proof_run_dir/$scenario"
  mkdir -p "$proof_scenario_dir"
  proof_receipts_file="$proof_scenario_dir/receipts.jsonl"
  proof_transactions_file="$proof_scenario_dir/transactions.jsonl"
  : > "$proof_receipts_file"
  : > "$proof_transactions_file"
  proof_trace_sequence="0"
  proof_rpc="http://127.0.0.1:$port"

  anvil \
    --quiet \
    --fork-url "$POLYGON_RPC_URL" \
    --fork-block-number "$proof_fork_block" \
    --chain-id "$proof_chain_id" \
    --host 127.0.0.1 \
    --port "$port" \
    >"$proof_scenario_dir/anvil.log" 2>&1 &
  proof_anvil_pid="$!"
  wait_for_fork_rpc
  # This proof is the mandatory barrier before any local storage write,
  # impersonation, time advance, or transaction.
  verify_fresh_fork "$scenario"
  proof_last_timestamp="$(read_block_timestamp "0x$(printf '%x' "$proof_fork_block")")"
  [[ "$proof_start_timestamp" -gt "$proof_last_timestamp" ]] || fail "fixed proof timestamp must follow the fork block"
}

stop_fresh_fork() {
  cleanup
  proof_anvil_pid=""
  proof_rpc=""
  proof_last_timestamp=""
}

set_next_timestamp() {
  local timestamp="$1"
  [[ "$timestamp" -gt "$proof_last_timestamp" ]] || fail "timestamps must increase deterministically"
  cast rpc --rpc-url "$proof_rpc" evm_setNextBlockTimestamp "$(cast to-hex "$timestamp")" >/dev/null
}

record_successful_receipt() {
  local expected_timestamp="$1"
  local action="$2"
  local receipt="$3"
  local status
  local block_number
  local actual_timestamp
  local transaction_hash
  local transaction
  local receipt_block_hash
  local transaction_block_hash
  local transaction_block_number

  status="$(jq -er '.status' <<<"$receipt")"
  [[ "$status" == "0x1" ]] || fail "transaction receipt was not successful"
  block_number="$(jq -er '.blockNumber' <<<"$receipt")"
  actual_timestamp="$(read_block_timestamp "$block_number")"
  [[ "$actual_timestamp" == "$expected_timestamp" ]] || fail "receipt timestamp $actual_timestamp did not equal $expected_timestamp"
  receipt="$(jq -c --arg blockTimestamp "$(cast to-hex "$actual_timestamp")" '. + {blockTimestamp:$blockTimestamp}' <<<"$receipt")"
  transaction_hash="$(jq -er '.transactionHash' <<<"$receipt")"
  transaction="$(cast rpc --rpc-url "$proof_rpc" eth_getTransactionByHash "$transaction_hash")"
  [[ "$(lowercase "$(jq -er '.hash' <<<"$transaction")")" == "$(lowercase "$transaction_hash")" ]] || fail "transaction hash did not match its receipt"
  receipt_block_hash="$(jq -er '.blockHash' <<<"$receipt")"
  transaction_block_hash="$(jq -er '.blockHash' <<<"$transaction")"
  transaction_block_number="$(jq -er '.blockNumber' <<<"$transaction")"
  [[ "$(lowercase "$transaction_block_hash")" == "$(lowercase "$receipt_block_hash")" ]] || fail "transaction block hash did not match its receipt"
  [[ "$transaction_block_number" == "$block_number" ]] || fail "transaction block number did not match its receipt"
  proof_last_timestamp="$actual_timestamp"
  proof_trace_sequence="$((proof_trace_sequence + 1))"
  jq -c '.' <<<"$receipt" >> "$proof_receipts_file"
  jq -cn \
    --arg sequence "$proof_trace_sequence" \
    --arg action "$action" \
    --arg expectedTimestamp "$expected_timestamp" \
    --argjson transaction "$transaction" \
    '{sequence:$sequence, action:$action, expectedTimestamp:$expectedTimestamp, transaction:{hash:$transaction.hash, from:$transaction.from, to:$transaction.to, input:$transaction.input, blockHash:$transaction.blockHash, blockNumber:$transaction.blockNumber}}' \
    >> "$proof_transactions_file"
}

send_unlocked_at() {
  local expected_timestamp="$1"
  local action="$2"
  local sender="$3"
  shift 3
  local receipt
  set_next_timestamp "$expected_timestamp"
  receipt="$(cast send --rpc-url "$proof_rpc" --unlocked --from "$sender" --gas-limit 1000000 --json "$@")"
  record_successful_receipt "$expected_timestamp" "$action" "$receipt"
}

write_receipt_manifest() {
  local receipt
  local digest
  local transaction_hash
  local manifest="$proof_scenario_dir/receipts.sha256"
  : > "$manifest"
  while IFS= read -r receipt; do
    transaction_hash="$(jq -er '.transactionHash' <<<"$receipt")"
    digest="$(printf '%s\n' "$receipt" | shasum -a 256 | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$transaction_hash" >> "$manifest"
  done < "$proof_receipts_file"
}

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

write_artifact_manifest() {
  local artifact
  local digest
  local manifest="$proof_scenario_dir/artifacts.sha256"
  : > "$manifest"
  for artifact in receipts.jsonl receipts.sha256 transactions.jsonl summary.json; do
    digest="$(file_sha256 "$proof_scenario_dir/$artifact")"
    printf '%s  %s\n' "$digest" "$artifact" >> "$manifest"
  done
  if [[ -f "$proof_scenario_dir/swap-revert.txt" ]]; then
    for artifact in swap-revert.txt open-rebalance-revert.txt reserve-rebalance-revert.txt; do
      digest="$(file_sha256 "$proof_scenario_dir/$artifact")"
      printf '%s  %s\n' "$digest" "$artifact" >> "$manifest"
    done
  fi
}

prepare_witness_seed() {
  local initial_supply
  local seeded_supply
  local initial_trader_europ
  local initial_trader_eurm
  local initial_balance_storage
  local initial_supply_storage
  local initial_pool_europ
  local initial_pool_eurm

  initial_supply="$(read_uint "$proof_europ" 'totalSupply()(uint256)')"
  initial_trader_europ="$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_trader")"
  initial_trader_eurm="$(read_uint "$proof_eurm" 'balanceOf(address)(uint256)' "$proof_trader")"
  initial_pool_europ="$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_pool")"
  initial_pool_eurm="$(read_uint "$proof_eurm" 'balanceOf(address)(uint256)' "$proof_pool")"
  initial_balance_storage="$(cast storage --rpc-url "$proof_rpc" "$proof_europ" "$proof_europ_balance_slot")"
  initial_supply_storage="$(cast storage --rpc-url "$proof_rpc" "$proof_europ" "$proof_europ_total_supply_slot")"

  [[ "$initial_trader_europ" == "0" ]] || fail "local trader must start without EUROP"
  [[ "$initial_trader_eurm" == "0" ]] || fail "local trader must start without EURm"
  [[ "$(lowercase "$initial_balance_storage")" == "$(uint_to_bytes32 "$initial_trader_europ")" ]] || fail "EUROP balance slot does not match balanceOf getter"
  [[ "$(lowercase "$initial_supply_storage")" == "$(uint_to_bytes32 "$initial_supply")" ]] || fail "EUROP total-supply slot does not match totalSupply getter"

  seeded_supply="$(node -e 'process.stdout.write((BigInt(process.argv[1]) + BigInt(process.argv[2])).toString())' "$initial_supply" "$proof_seed_europ")"
  cast rpc --rpc-url "$proof_rpc" anvil_setStorageAt "$proof_europ" "$proof_europ_balance_slot" "$(uint_to_bytes32 "$proof_seed_europ")" >/dev/null
  cast rpc --rpc-url "$proof_rpc" anvil_setStorageAt "$proof_europ" "$proof_europ_total_supply_slot" "$(uint_to_bytes32 "$seeded_supply")" >/dev/null
  cast rpc --rpc-url "$proof_rpc" evm_mine >/dev/null

  [[ "$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_trader")" == "$proof_seed_europ" ]] || fail "seeded local EUROP balance did not verify"
  [[ "$(read_uint "$proof_europ" 'totalSupply()(uint256)')" == "$seeded_supply" ]] || fail "seeded EUROP supply did not verify"
  [[ "$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_pool")" == "$initial_pool_europ" ]] || fail "pool EUROP changed during local seed"

  proof_initial_supply="$initial_supply"
  proof_seeded_supply="$seeded_supply"
  proof_initial_trader_eurm="$initial_trader_eurm"
  proof_initial_pool_europ="$initial_pool_europ"
  proof_initial_pool_eurm="$initial_pool_eurm"
}

expect_trading_suspended() {
  local name="$1"
  shift
  local output_file="$proof_scenario_dir/$name-revert.txt"
  if "$@" >"$output_file" 2>&1; then
    fail "expected $name eth_call to revert while trading is suspended"
  fi
  grep -Eq "data: \"?${proof_trading_suspended_selector}\"?$" "$output_file" || fail "$name did not return exactly TradingSuspended"
}

run_witness_scenario() {
  local cycle
  local cycle_timestamp
  local rebalance_timestamp
  local quote
  local final_eurm
  local final_trader_europ
  local final_pool_europ
  local final_pool_eurm
  local final_supply
  local receipt_count
  local final_timestamp
  local elapsed
  local receipts_sha256
  local receipt_index_sha256
  local transactions_sha256

  start_fresh_fork "witness" "$proof_witness_port"
  prepare_witness_seed

  for cycle in $(seq 1 "$proof_cycles"); do
    cycle_timestamp="$((proof_start_timestamp + (cycle - 1) * proof_cycle_seconds))"
    quote="$(read_uint "$proof_pool" 'getAmountOut(uint256,address)(uint256)' "$proof_europ_input_per_cycle" "$proof_europ")"
    [[ "$quote" == "$proof_eurm_output_per_cycle" ]] || fail "cycle $cycle quote was not exactly 1,999 EURm"

    send_unlocked_at "$cycle_timestamp" "transfer" "$proof_trader" "$proof_europ" 'transfer(address,uint256)(bool)' "$proof_pool" "$proof_europ_input_per_cycle"
    send_unlocked_at "$((cycle_timestamp + 1))" "swap" "$proof_trader" "$proof_pool" 'swap(uint256,uint256,address,bytes)' "$proof_eurm_output_per_cycle" 0 "$proof_trader" 0x

    rebalance_timestamp="$((cycle_timestamp + 2))"
    if [[ "$cycle" == "$proof_cycles" ]]; then
      rebalance_timestamp="$((proof_start_timestamp + 15080))"
    fi
    cast call --rpc-url "$proof_rpc" "$proof_reserve_strategy" 'rebalance(address)' "$proof_pool" >/dev/null
    send_unlocked_at "$rebalance_timestamp" "reserve-rebalance" "$proof_trader" "$proof_reserve_strategy" 'rebalance(address)' "$proof_pool"
  done

  final_timestamp="$proof_last_timestamp"
  elapsed="$((final_timestamp - proof_start_timestamp))"
  final_eurm="$(read_uint "$proof_eurm" 'balanceOf(address)(uint256)' "$proof_trader")"
  final_trader_europ="$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_trader")"
  final_pool_europ="$(read_uint "$proof_europ" 'balanceOf(address)(uint256)' "$proof_pool")"
  final_pool_eurm="$(read_uint "$proof_eurm" 'balanceOf(address)(uint256)' "$proof_pool")"
  final_supply="$(read_uint "$proof_europ" 'totalSupply()(uint256)')"
  receipt_count="$(wc -l < "$proof_receipts_file" | tr -d ' ')"

  [[ "$receipt_count" == "153" ]] || fail "witness must have exactly 153 successful receipts"
  [[ "$elapsed" == "15080" && "$elapsed" -le "$proof_response_seconds" ]] || fail "witness elapsed time must be exactly 15,080 seconds inside S"
  [[ "$final_eurm" == "$proof_expected_external_eurm" ]] || fail "witness external EURm result changed"
  uint_greater_than "$final_eurm" "$proof_budget_eurm" || fail "witness did not exceed the approved EURm budget"
  [[ "$final_trader_europ" == "0" ]] || fail "trader retains EUROP after witness"
  [[ "$final_pool_europ" -gt "$proof_initial_pool_europ" ]] || fail "pool EUROP did not reflect witness input"
  uint_greater_than "$final_pool_eurm" 0 || fail "pool EURm balance is invalid"
  [[ "$final_supply" == "$proof_seeded_supply" ]] || fail "EUROP supply changed beyond the local seed"

  write_receipt_manifest
  receipts_sha256="$(file_sha256 "$proof_receipts_file")"
  receipt_index_sha256="$(file_sha256 "$proof_scenario_dir/receipts.sha256")"
  transactions_sha256="$(file_sha256 "$proof_transactions_file")"
  jq -n \
    --arg scenario "local-fork-witness" \
    --arg modelId "$proof_witness_model" \
    --arg mentoCoreCommit "$proof_mento_core_commit" \
    --arg chainId "$proof_chain_id" \
    --arg blockNumber "$proof_fork_block" \
    --arg blockHash "$proof_fork_hash" \
    --arg pool "$proof_pool" \
    --arg reserveStrategy "$proof_reserve_strategy" \
    --arg cycles "$proof_cycles" \
    --arg transactionsPerCycle "3" \
    --arg inputPerCycleEuropRaw "$proof_europ_input_per_cycle" \
    --arg outputPerCycleEurmRaw "$proof_eurm_output_per_cycle" \
    --arg receiptCount "$receipt_count" \
    --arg successfulReserveRebalances "$proof_cycles" \
    --arg elapsedSeconds "$elapsed" \
    --arg externalEurmRaw "$final_eurm" \
    --arg budgetEurmRaw "$proof_budget_eurm" \
    --arg initialTraderEurmRaw "$proof_initial_trader_eurm" \
    --arg finalTraderEuropRaw "$final_trader_europ" \
    --arg initialPoolEuropRaw "$proof_initial_pool_europ" \
    --arg poolEuropRaw "$final_pool_europ" \
    --arg initialPoolEurmRaw "$proof_initial_pool_eurm" \
    --arg poolEurmRaw "$final_pool_eurm" \
    --arg initialSupplyRaw "$proof_initial_supply" \
    --arg seededSupplyRaw "$proof_seeded_supply" \
    --arg finalSupplyRaw "$final_supply" \
    --arg receiptsSha256 "$receipts_sha256" \
    --arg receiptIndexSha256 "$receipt_index_sha256" \
    --arg transactionsSha256 "$transactions_sha256" \
    --arg receiptManifest "receipts.sha256" \
    --arg artifactManifest "artifacts.sha256" \
    '{scenario:$scenario, modelId:$modelId, mentoCoreCommit:$mentoCoreCommit, chainId:$chainId, blockNumber:$blockNumber, blockHash:$blockHash, pool:$pool, reserveStrategy:$reserveStrategy, cycles:$cycles, transactionsPerCycle:$transactionsPerCycle, inputPerCycleEuropRaw:$inputPerCycleEuropRaw, outputPerCycleEurmRaw:$outputPerCycleEurmRaw, receiptCount:$receiptCount, successfulReserveRebalances:$successfulReserveRebalances, elapsedSeconds:$elapsedSeconds, externalEurmRaw:$externalEurmRaw, budgetEurmRaw:$budgetEurmRaw, initialTraderEurmRaw:$initialTraderEurmRaw, finalTraderEuropRaw:$finalTraderEuropRaw, initialPoolEuropRaw:$initialPoolEuropRaw, poolEuropRaw:$poolEuropRaw, initialPoolEurmRaw:$initialPoolEurmRaw, poolEurmRaw:$poolEurmRaw, initialSupplyRaw:$initialSupplyRaw, seededSupplyRaw:$seededSupplyRaw, finalSupplyRaw:$finalSupplyRaw, receiptsSha256:$receiptsSha256, receiptIndexSha256:$receiptIndexSha256, transactionsSha256:$transactionsSha256, receiptManifest:$receiptManifest, artifactManifest:$artifactManifest, claimStatus:"unattested", provenance:"unattested", localOnly:true, productionActivity:false}' \
    > "$proof_scenario_dir/summary.json"
  write_artifact_manifest
  stop_fresh_fork
}

run_halt_scenario() {
  local healthy_quote
  local halt_rate_json
  local observed_halt_rate
  local observed_halt_denominator
  local halted_mode
  local restored_rate_json
  local observed_restored_rate
  local observed_restored_denominator
  local restored_mode
  local restored_quote
  local receipt_count
  local receipts_sha256
  local receipt_index_sha256
  local transactions_sha256

  start_fresh_fork "halt" "$proof_halt_port"
  healthy_quote="$(read_uint "$proof_pool" 'getAmountOut(uint256,address)(uint256)' 1000000 "$proof_europ")"
  uint_greater_than "$healthy_quote" 0 || fail "healthy swap quote must be positive"
  [[ "$(read_uint "$proof_breaker_box" 'rateFeedTradingMode(address)(uint8)' "$proof_feed")" == "0" ]] || fail "feed must start in normal trading mode"

  cast rpc --rpc-url "$proof_rpc" anvil_impersonateAccount "$proof_safe" >/dev/null
  cast rpc --rpc-url "$proof_rpc" anvil_setBalance "$proof_safe" 0x21e19e0c9bab2400000 >/dev/null
  send_unlocked_at "$proof_start_timestamp" "halt-report" "$proof_safe" "$proof_sorted_oracles" 'report(address,uint256,address,address)' "$proof_feed" "$proof_halt_rate" "$proof_zero" "$proof_zero"

  halt_rate_json="$(cast call --rpc-url "$proof_rpc" --json "$proof_sorted_oracles" 'medianRate(address)(uint256,uint256)' "$proof_feed")"
  observed_halt_rate="$(printf '%s' "$halt_rate_json" | jq -er '.[0] | tostring')"
  observed_halt_denominator="$(printf '%s' "$halt_rate_json" | jq -er '.[1] | tostring')"
  [[ "$observed_halt_rate" == "$proof_halt_rate" ]] || fail "halt report rate did not match SortedOracles readback"
  [[ "$observed_halt_denominator" == "$proof_rate_denominator" ]] || fail "halt report denominator did not match SortedOracles readback"
  halted_mode="$(read_uint "$proof_breaker_box" 'rateFeedTradingMode(address)(uint8)' "$proof_feed")"
  [[ "$halted_mode" == "1" ]] || fail "0.994 report did not halt trading"
  # cast call sends an eth_call, so these checks cannot mutate either fork.
  expect_trading_suspended "swap" cast call --rpc-url "$proof_rpc" "$proof_pool" 'swap(uint256,uint256,address,bytes)' 1 0 "$proof_trader" 0x
  expect_trading_suspended "open-rebalance" cast call --rpc-url "$proof_rpc" "$proof_open_strategy" 'rebalance(address)' "$proof_pool"
  expect_trading_suspended "reserve-rebalance" cast call --rpc-url "$proof_rpc" "$proof_reserve_strategy" 'rebalance(address)' "$proof_pool"

  send_unlocked_at "$((proof_start_timestamp + 2))" "restore-report" "$proof_safe" "$proof_sorted_oracles" 'report(address,uint256,address,address)' "$proof_feed" "$proof_normal_rate" "$proof_zero" "$proof_zero"
  restored_rate_json="$(cast call --rpc-url "$proof_rpc" --json "$proof_sorted_oracles" 'medianRate(address)(uint256,uint256)' "$proof_feed")"
  observed_restored_rate="$(printf '%s' "$restored_rate_json" | jq -er '.[0] | tostring')"
  observed_restored_denominator="$(printf '%s' "$restored_rate_json" | jq -er '.[1] | tostring')"
  [[ "$observed_restored_rate" == "$proof_normal_rate" ]] || fail "restored report rate did not match SortedOracles readback"
  [[ "$observed_restored_denominator" == "$proof_rate_denominator" ]] || fail "restored report denominator did not match SortedOracles readback"
  restored_mode="$(read_uint "$proof_breaker_box" 'rateFeedTradingMode(address)(uint8)' "$proof_feed")"
  restored_quote="$(read_uint "$proof_pool" 'getAmountOut(uint256,address)(uint256)' 1000000 "$proof_europ")"
  receipt_count="$(wc -l < "$proof_receipts_file" | tr -d ' ')"

  [[ "$restored_mode" == "0" ]] || fail "1.0 report did not restore normal trading mode"
  [[ "$restored_quote" == "$healthy_quote" ]] || fail "swap quote did not restore after the cooldown"
  [[ "$receipt_count" == "2" ]] || fail "halt proof must contain exactly two report receipts"

  write_receipt_manifest
  receipts_sha256="$(file_sha256 "$proof_receipts_file")"
  receipt_index_sha256="$(file_sha256 "$proof_scenario_dir/receipts.sha256")"
  transactions_sha256="$(file_sha256 "$proof_transactions_file")"
  jq -n \
    --arg scenario "local-fork-halt" \
    --arg chainId "$proof_chain_id" \
    --arg blockNumber "$proof_fork_block" \
    --arg blockHash "$proof_fork_hash" \
    --arg controlSafe "$proof_safe" \
    --arg sortedOracles "$proof_sorted_oracles" \
    --arg breakerBox "$proof_breaker_box" \
    --arg rateFeedId "$proof_feed" \
    --arg haltRateRaw "$observed_halt_rate" \
    --arg haltedMode "$halted_mode" \
    --arg restoredRateRaw "$observed_restored_rate" \
    --arg restoredMode "$restored_mode" \
    --arg receiptCount "$receipt_count" \
    --arg receiptsSha256 "$receipts_sha256" \
    --arg receiptIndexSha256 "$receipt_index_sha256" \
    --arg transactionsSha256 "$transactions_sha256" \
    --arg receiptManifest "receipts.sha256" \
    --arg artifactManifest "artifacts.sha256" \
    '{scenario:$scenario, chainId:$chainId, blockNumber:$blockNumber, blockHash:$blockHash, controlSafe:$controlSafe, sortedOracles:$sortedOracles, breakerBox:$breakerBox, rateFeedId:$rateFeedId, haltRateRaw:$haltRateRaw, haltedMode:$haltedMode, swapSuspended:true, openRebalanceSuspended:true, reserveRebalanceSuspended:true, restoredRateRaw:$restoredRateRaw, restoredMode:$restoredMode, receiptCount:$receiptCount, receiptsSha256:$receiptsSha256, receiptIndexSha256:$receiptIndexSha256, transactionsSha256:$transactionsSha256, receiptManifest:$receiptManifest, artifactManifest:$artifactManifest, claimStatus:"unattested", provenance:"unattested", localOnly:true, productionActivity:false}' \
    > "$proof_scenario_dir/summary.json"
  write_artifact_manifest
  stop_fresh_fork
}

run_witness_scenario
run_halt_scenario

echo "EUROP local-fork diagnostic completed: $proof_run_dir"
echo "- observed candidate paths are unattested local diagnostics; they do not establish fork-source or execution provenance"
echo "- witness: $proof_run_dir/witness/summary.json"
echo "- halt: $proof_run_dir/halt/summary.json"
