import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { ProposalCreatedEvent } from "../types.js";

/**
 * Given a ProposalCreatedEvent, calculate the corresponding timelock operation ID.
 * Governance Watchdogs need the timelock operation ID to veto queued proposals.
 *
 * The governor proposal ID and the timelock operation ID are not the same, which can
 * be confusing. They use different hashing mechanisms to calculate their respective IDs:
 * - Timelock Controller Operation IDs: https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/blob/58fa0f81c4036f1a3b616fdffad2fd27e5d5ce21/contracts/governance/TimelockControllerUpgradeable.sol#L218
 * - Governor Proposal IDs: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/0a25c1940ca220686588c4af3ec526f725fe2582/contracts/governance/Governor.sol#L139
 */

/**
 * Normalize a value to an array, handling comma-separated strings from Quicknode
 */
function normalizeToArray<T>(value: T | readonly T[]): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }

  // Handle comma-separated strings (Quicknode sometimes sends arrays as comma-separated strings)
  if (typeof value === "string" && value.includes(",")) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [String(value)];
}

export default function getProposalTimeLockId(
  event: ProposalCreatedEvent,
): string {
  const { targets, values, calldatas, description } = event;
  const descriptionHash = keccak256(new Uint8Array(Buffer.from(description)));

  // Normalize fields to arrays, handling comma-separated strings from Quicknode
  const targetsArray = normalizeToArray(targets) as `0x${string}`[];
  const valuesArray = normalizeToArray(values).map((v) => BigInt(v));
  const calldatasArray = normalizeToArray(calldatas) as `0x${string}`[];

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address[], uint256[], bytes[], uint256, bytes32"),
      // _timelockIds[proposalId] = _timelock.hashOperationBatch(targets, values, calldatas, 0, descriptionHash);
      [targetsArray, valuesArray, calldatasArray, 0n, descriptionHash],
    ),
  );
}
