#!/usr/bin/env tsx
/**
 * Script to manually reprocess an event and trigger notifications
 *
 * Usage:
 *   pnpm run reprocess:event <path-to-event.json>
 *   pnpm run reprocess:event --tx <transaction-hash>
 *   pnpm run reprocess:event --block <block-hash>
 *   pnpm run reprocess:event --json '{"result":[...]}'
 *
 * Note: By default, this runs in development mode (uses test channels).
 * Set NODE_ENV=production to use production channels.
 */

import { readFileSync } from "fs";
import { createPublicClient, decodeEventLog, http } from "viem";
import { celo } from "viem/chains";
import { processEvent } from "../src/events/process-event.js";
import { initializeEventRegistry } from "../src/events/registry.js";
import {
  EventType,
  QuicknodeEvent,
  QuicknodePayload,
} from "../src/events/types.js";
import parseRequestBody from "../src/utils/parse-request-body.js";

// Governor contract address
const GOVERNOR_ADDRESS = "0x47036d78bb3169b4f5560dd77bf93f4412a59852" as const;

// Minimal ABI for governance events we care about
const GOVERNOR_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint256",
        name: "proposalId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "address",
        name: "proposer",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address[]",
        name: "targets",
        type: "address[]",
      },
      {
        indexed: false,
        internalType: "uint256[]",
        name: "values",
        type: "uint256[]",
      },
      {
        indexed: false,
        internalType: "string[]",
        name: "signatures",
        type: "string[]",
      },
      {
        indexed: false,
        internalType: "bytes[]",
        name: "calldatas",
        type: "bytes[]",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "startBlock",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "endBlock",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "string",
        name: "description",
        type: "string",
      },
    ],
    name: "ProposalCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint256",
        name: "proposalId",
        type: "uint256",
      },
      { indexed: false, internalType: "uint256", name: "eta", type: "uint256" },
    ],
    name: "ProposalQueued",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint256",
        name: "proposalId",
        type: "uint256",
      },
    ],
    name: "ProposalExecuted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint256",
        name: "proposalId",
        type: "uint256",
      },
    ],
    name: "ProposalCanceled",
    type: "event",
  },
] as const;

// Set default to development mode if not specified
process.env.NODE_ENV ??= "development";

// Initialize event registry
initializeEventRegistry();

/**
 * Fetch events from blockchain by transaction hash
 */
async function fetchEventsByTxHash(
  txHash: `0x${string}`,
): Promise<QuicknodeEvent[]> {
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(),
  });

  console.log(`🔍 Fetching transaction ${txHash}...`);

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

  const logCount = receipt.logs.length;
  console.log(`📦 Found ${String(logCount)} log(s) in transaction`);

  const events: QuicknodeEvent[] = [];

  for (const log of receipt.logs) {
    // Only process logs from the governor contract
    if (log.address.toLowerCase() !== GOVERNOR_ADDRESS.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: GOVERNOR_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      // Map decoded event to QuicknodeEvent format
      const eventName = decoded.eventName as EventType;
      if (
        ![
          EventType.ProposalCreated,
          EventType.ProposalQueued,
          EventType.ProposalExecuted,
          EventType.ProposalCanceled,
        ].includes(eventName)
      ) {
        continue;
      }

      const baseEvent = {
        address: log.address,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(),
        logIndex: `0x${log.logIndex.toString(16).padStart(2, "0")}`,
        name: eventName,
        transactionHash: txHash,
      };

      let event: QuicknodeEvent;

      if (eventName === EventType.ProposalCreated) {
        const args = decoded.args as {
          proposalId: bigint;
          proposer: `0x${string}`;
          targets: readonly `0x${string}`[];
          values: readonly bigint[];
          signatures: readonly string[];
          calldatas: readonly `0x${string}`[];
          startBlock: bigint;
          endBlock: bigint;
          description: string;
        };
        // Handle arrays: if single value, keep as single value; if array, keep as array
        const values = args.values.length === 1 ? args.values[0] : args.values;
        const targets =
          args.targets.length === 1 ? args.targets[0] : args.targets;
        const calldatas =
          args.calldatas.length === 1 ? args.calldatas[0] : args.calldatas;
        const signatures =
          args.signatures.length === 1 ? args.signatures[0] : args.signatures;
        event = {
          ...baseEvent,
          proposalId: args.proposalId,
          proposer: args.proposer,
          targets,
          values,
          signatures,
          calldatas,
          startBlock: args.startBlock,
          endBlock: args.endBlock,
          description: args.description,
          version: 1, // Default version for events fetched from blockchain
        } as QuicknodeEvent;
      } else if (eventName === EventType.ProposalQueued) {
        const args = decoded.args as { proposalId: bigint; eta: bigint };
        event = {
          ...baseEvent,
          proposalId: args.proposalId,
          eta: args.eta,
        } as QuicknodeEvent;
      } else if (eventName === EventType.ProposalExecuted) {
        const args = decoded.args as { proposalId: bigint };
        event = {
          ...baseEvent,
          proposalId: args.proposalId,
        } as QuicknodeEvent;
      } else if (eventName === EventType.ProposalCanceled) {
        const args = decoded.args as { proposalId: bigint };
        event = {
          ...baseEvent,
          proposalId: args.proposalId,
        } as QuicknodeEvent;
      } else {
        continue;
      }

      events.push(event);
      console.log(`✅ Decoded ${eventName} event`);
    } catch (error: unknown) {
      // Skip logs that don't match our ABI
      if (process.env.DEBUG) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.log(
          `⚠️  Skipping log (not a governance event): ${errorMessage}`,
        );
      }
    }
  }

  return events;
}

/**
 * Fetch events from blockchain by block hash
 */
async function fetchEventsByBlockHash(
  blockHash: `0x${string}`,
): Promise<QuicknodeEvent[]> {
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(),
  });

  console.log(`🔍 Fetching block ${blockHash}...`);

  const block = await publicClient.getBlock({
    blockHash,
    includeTransactions: true,
  });

  const txCount = block.transactions.length;
  console.log(`📦 Found ${String(txCount)} transaction(s) in block`);

  const allEvents: QuicknodeEvent[] = [];

  for (const tx of block.transactions) {
    if (typeof tx === "string") {
      // Transaction hash only, fetch receipt
      try {
        const events = await fetchEventsByTxHash(tx as `0x${string}`);
        allEvents.push(...events);
      } catch (error: unknown) {
        if (process.env.DEBUG) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const txHashStr = String(tx);
          console.log(
            `⚠️  Error fetching events from tx ${txHashStr}: ${errorMessage}`,
          );
        }
      }
    }
  }

  return allEvents;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: reprocess-event.ts <path-to-event.json> | --tx <tx-hash> | --block <block-hash> | --json '<json-string>'",
    );
    console.error("");
    console.error("Examples:");
    console.error(
      "  pnpm run reprocess:event src/events/fixtures/proposal-created.fixture.json",
    );
    console.error(
      "  pnpm run reprocess:event -- --tx 0x71c89ff65fe1e7b2ae58f6459959507bc405421efa18159fb4e96b589a140c4f",
    );
    console.error(
      "  pnpm run reprocess:event 0x71c89ff65fe1e7b2ae58f6459959507bc405421efa18159fb4e96b589a140c4f",
    );
    console.error(
      "  pnpm run reprocess:event -- --block 0xf0fac639cac5ba78322ebc9d41280577ffd73616ac711e26a47efca776ac005a",
    );
    console.error("  pnpm run reprocess:event -- --json '{\"result\":[...]}'");
    console.error("");
    console.error("Environment:");
    const nodeEnvDisplay = process.env.NODE_ENV ?? "development";
    console.error(
      `  NODE_ENV=${nodeEnvDisplay} (development = test channels, production = production channels)`,
    );
    process.exit(1);
  }

  let eventPayload: unknown;
  let events: QuicknodeEvent[] | null = null;

  // Helper to check if a string looks like a transaction hash (0x + 64 hex chars = 66 chars)
  const isTxHash = (str: string): boolean => {
    return (
      (str.startsWith("0x") && str.length === 66) ||
      (!str.startsWith("0x") && str.length === 64)
    );
  };

  // Helper to check if a string looks like a block hash (0x + 64 hex chars = 66 chars)
  const isBlockHash = (str: string): boolean => {
    return (
      (str.startsWith("0x") && str.length === 66) ||
      (!str.startsWith("0x") && str.length === 64)
    );
  };

  // Check if fetching from blockchain
  // Support both explicit flags and auto-detection of hashes
  if (args[0] === "--tx" && args[1]) {
    const txInput = args[1];
    const txHash = (
      txInput.startsWith("0x") ? txInput : `0x${txInput}`
    ) as `0x${string}`;
    events = await fetchEventsByTxHash(txHash);
  } else if (args[0] === "--block" && args[1]) {
    const blockInput = args[1];
    const blockHash = (
      blockInput.startsWith("0x") ? blockInput : `0x${blockInput}`
    ) as `0x${string}`;
    events = await fetchEventsByBlockHash(blockHash);
  } else if (args.length === 1 && isTxHash(args[0])) {
    // Auto-detect transaction hash if single argument looks like one
    const txInput = args[0];
    const txHash = (
      txInput.startsWith("0x") ? txInput : `0x${txInput}`
    ) as `0x${string}`;
    events = await fetchEventsByTxHash(txHash);
  } else if (args.length === 1 && isBlockHash(args[0])) {
    // Auto-detect block hash if single argument looks like one
    const blockInput = args[0];
    const blockHash = (
      blockInput.startsWith("0x") ? blockInput : `0x${blockInput}`
    ) as `0x${string}`;
    events = await fetchEventsByBlockHash(blockHash);
  } else if (args[0] === "--json" && args[1]) {
    try {
      eventPayload = JSON.parse(args[1]);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("❌ Failed to parse JSON string:", errorMessage);
      process.exit(1);
    }
  } else {
    // Assume it's a file path
    const filePath = args[0];
    try {
      const fileContent = readFileSync(filePath, "utf-8");
      eventPayload = JSON.parse(fileContent);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `❌ Failed to read or parse file "${filePath}": ${errorMessage}`,
      );
      process.exit(1);
    }
  }

  // If events were fetched from blockchain, use them directly
  // Otherwise, parse from payload
  if (!events) {
    // Normalize the payload format - parseRequestBody expects QuicknodePayload format
    let normalizedPayload: QuicknodePayload;

    // Check if it's already in QuicknodePayload format (has 'result' array)
    if (
      typeof eventPayload === "object" &&
      eventPayload !== null &&
      "result" in eventPayload &&
      Array.isArray((eventPayload as QuicknodePayload).result)
    ) {
      normalizedPayload = eventPayload as QuicknodePayload;
    } else if (Array.isArray(eventPayload)) {
      // If it's an array of events, wrap it in the expected format
      normalizedPayload = {
        result: eventPayload as unknown as QuicknodeEvent[],
      };
    } else if (
      typeof eventPayload === "object" &&
      eventPayload !== null &&
      "name" in eventPayload
    ) {
      // If it's a single event object, wrap it in an array
      normalizedPayload = {
        result: [eventPayload as unknown as QuicknodeEvent],
      };
    } else {
      console.error(
        "❌ Invalid event payload format. Expected QuicknodePayload format with 'result' array, an array of events, or a single event object.",
      );
      process.exit(1);
    }

    // Parse the request body to extract events
    try {
      events = parseRequestBody(normalizedPayload);
    } catch (error) {
      console.error("❌ Failed to parse event payload:", error);
      if (error instanceof Error) {
        console.error("Error details:", error.message);
      }
      process.exit(1);
    }
  }

  if (events.length === 0) {
    console.error("❌ No valid events found in payload");
    process.exit(1);
  }

  const eventCount = events.length;
  const nodeEnv = process.env.NODE_ENV ?? "development";
  console.log(`📋 Found ${String(eventCount)} event(s) to process`);
  console.log(`🔧 Environment: ${nodeEnv}\n`);

  // Process each event
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const eventIndex = i + 1;
    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `Processing event ${String(eventIndex)}/${String(eventCount)}: ${event.name}`,
    );
    console.log(`Block: ${event.blockNumber}`);
    console.log(`Transaction: ${event.transactionHash}`);
    console.log(`${"=".repeat(60)}\n`);

    try {
      await processEvent(event);
      console.log(`\n✅ Successfully processed ${event.name} event`);
    } catch (error: unknown) {
      console.error(`\n❌ Failed to process ${event.name} event:`, error);
      if (error instanceof Error) {
        console.error("Error details:", error.message);
        if (error.stack) {
          console.error("Stack trace:", error.stack);
        }
      }
      process.exit(1);
    }
  }

  console.log(`\n✅ All events processed successfully!`);
}

main().catch((error: unknown) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
