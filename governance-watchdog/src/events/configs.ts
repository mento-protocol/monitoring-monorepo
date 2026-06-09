import { DiscordMessageBuilder } from "../event-notifications/message-builder.discord.js";
import { TelegramMessageBuilder } from "../event-notifications/message-builder.telegram.js";
import { createEventValidator } from "./event-validator-factory.js";
import {
  EventConfig,
  EventType,
  MedianUpdatedEvent,
  ProposalCanceledEvent,
  ProposalCreatedEvent,
  ProposalExecutedEvent,
  ProposalQueuedEvent,
  QuicknodeEvent,
} from "./types.js";
import { eventTypeToTitle } from "./utils/event-type-to-title.js";
import getProposalTimelockId from "./utils/get-proposal-time-lock-id.js";

/**
 * SINGLE SOURCE OF TRUTH FOR ALL EVENT CONFIGURATIONS
 *
 * To add a new event:
 * 1. Add the event to the EventType enum in src/events/types.ts
 * 2. Add the event interface to src/events/types.ts
 * 3. Add the event to EventTypeMap in src/events/types.ts
 * 4. Add a new entry to the EVENT_CONFIGS record below
 */
export const EVENT_CONFIGS = {
  // ===================================================================
  // PROPOSAL CREATED
  // ===================================================================
  [EventType.ProposalCreated]: {
    eventType: EventType.ProposalCreated,

    validateEvent: createEventValidator<QuicknodeEvent & ProposalCreatedEvent>({
      requiredFields: [
        "calldatas",
        "description",
        "endBlock",
        "proposalId",
        "proposer",
        "signatures",
        "startBlock",
        "targets",
        "values",
      ],
      // Additional validation for complex field types
      additionalValidation: (eventObj: Record<string, unknown>) => {
        const isValidCalldatas =
          typeof eventObj.calldatas === "string" ||
          Array.isArray(eventObj.calldatas);

        const isValidTargets =
          typeof eventObj.targets === "string" ||
          Array.isArray(eventObj.targets);

        const isValidValues =
          typeof eventObj.values === "string" || Array.isArray(eventObj.values);

        const isValidSignatures =
          typeof eventObj.signatures === "string" ||
          Array.isArray(eventObj.signatures);

        return (
          isValidCalldatas &&
          isValidTargets &&
          isValidValues &&
          isValidSignatures
        );
      },
    }),

    getDiscordMessage: (event: QuicknodeEvent & ProposalCreatedEvent) => {
      const timelockId = getProposalTimelockId(event);

      // Safely parse the description to extract title
      let title: string = eventTypeToTitle(EventType.ProposalCreated);
      if (event.description) {
        try {
          const parsed = JSON.parse(event.description) as { title?: string };
          if (typeof parsed.title === "string") {
            title = parsed.title;
          }
        } catch {
          title = eventTypeToTitle(EventType.ProposalCreated);
        }
      }

      return new DiscordMessageBuilder({ color: 0xa6e5f6, title }, undefined)
        .addProposalLink(event.proposalId)
        .addProposerLink(event.proposer)
        .addTimelockId(timelockId)
        .addTransactionLink(event.transactionHash, "Proposal")
        .build();
    },

    getTelegramMessage: (event: QuicknodeEvent & ProposalCreatedEvent) => {
      const timelockId = getProposalTimelockId(event);

      // Safely parse the description to extract title
      let proposalTitle = "Untitled Proposal";
      if (event.description) {
        try {
          const parsed = JSON.parse(event.description) as { title?: string };
          if (typeof parsed.title === "string") {
            proposalTitle = parsed.title;
          }
        } catch {
          // Keep default title if parsing fails
        }
      }

      return new TelegramMessageBuilder(
        `Please review the proposal and check if anything looks off.`,
      )
        .addTitle(proposalTitle)
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Proposal")
        .addProposerLink(event.proposer)
        .addTimelockId(timelockId);
    },

    emoji: "📝",
    deduplicationStrategy: "proposalId",
  } as EventConfig<QuicknodeEvent & ProposalCreatedEvent>,

  // ===================================================================
  // PROPOSAL QUEUED
  // ===================================================================
  [EventType.ProposalQueued]: {
    eventType: EventType.ProposalQueued,

    validateEvent: createEventValidator<QuicknodeEvent & ProposalQueuedEvent>({
      requiredFields: ["proposalId", "eta"],
    }),

    getDiscordMessage: (event: QuicknodeEvent & ProposalQueuedEvent) => {
      const executionTime = new Date(Number(event.eta) * 1000).toUTCString();

      return new DiscordMessageBuilder(
        {
          color: 0xf5a623,
          title: eventTypeToTitle(EventType.ProposalQueued),
        },
        `A proposal has been queued for execution on ${executionTime}.`,
      )
        .addProposalLink(event.proposalId)
        .addExecutionTime(event.eta)
        .addTransactionLink(event.transactionHash, "Queue")
        .build();
    },

    getTelegramMessage: (event: QuicknodeEvent & ProposalQueuedEvent) => {
      const executionTime = new Date(Number(event.eta) * 1000).toUTCString();

      return new TelegramMessageBuilder(
        `A proposal has been queued for execution on ${executionTime}. Please review the proposal and discuss with your fellow watchdogs if it should be vetoed.`,
      )
        .addExecutionTime(event.eta)
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Queue")
        .addField(
          "How to Veto",
          "https://mentolabs.notion.site/Mento-Governance-Watchdogs-1c523e14987740c99fa7dedd490c0aa9#9324b6cbe737428c96166d8e66c29f02",
        );
    },

    emoji: "⏱️",
    deduplicationStrategy: "proposalId",
  } as EventConfig<QuicknodeEvent & ProposalQueuedEvent>,

  // ===================================================================
  // PROPOSAL EXECUTED
  // ===================================================================
  [EventType.ProposalExecuted]: {
    eventType: EventType.ProposalExecuted,

    validateEvent: createEventValidator<QuicknodeEvent & ProposalExecutedEvent>(
      {
        requiredFields: ["proposalId"],
      },
    ),

    getDiscordMessage: (event: QuicknodeEvent & ProposalExecutedEvent) => {
      return new DiscordMessageBuilder(
        {
          color: 0x4caf50,
          title: eventTypeToTitle(EventType.ProposalExecuted),
        },
        "The proposal has been executed successfully!",
      )
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Execution")
        .build();
    },

    getTelegramMessage: (event: QuicknodeEvent & ProposalExecutedEvent) => {
      return new TelegramMessageBuilder(
        "The proposal has been executed successfully!",
      )
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Execution");
    },

    emoji: "✅",
    deduplicationStrategy: "proposalId",
  } as EventConfig<QuicknodeEvent & ProposalExecutedEvent>,

  // ===================================================================
  // PROPOSAL CANCELED
  // ===================================================================
  [EventType.ProposalCanceled]: {
    eventType: EventType.ProposalCanceled,

    validateEvent: createEventValidator<QuicknodeEvent & ProposalCanceledEvent>(
      {
        requiredFields: ["proposalId"],
      },
    ),

    getDiscordMessage: (event: QuicknodeEvent & ProposalCanceledEvent) => {
      return new DiscordMessageBuilder(
        {
          color: 0xff5252,
          title: eventTypeToTitle(EventType.ProposalCanceled),
        },
        "The proposal has been canceled and will not proceed further.",
      )
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Cancellation")
        .build();
    },

    getTelegramMessage: (event: QuicknodeEvent & ProposalCanceledEvent) => {
      return new TelegramMessageBuilder(
        "The proposal has been canceled and will not proceed further.",
      )
        .addProposalLink(event.proposalId)
        .addTransactionLink(event.transactionHash, "Cancellation");
    },

    emoji: "❌",
    deduplicationStrategy: "proposalId",
  } as EventConfig<QuicknodeEvent & ProposalCanceledEvent>,

  // ===================================================================
  // MEDIAN UPDATED (Health Check)
  // ===================================================================
  [EventType.MedianUpdated]: {
    eventType: EventType.MedianUpdated,

    validateEvent: createEventValidator<QuicknodeEvent & MedianUpdatedEvent>({
      requiredFields: ["token", "value"],
    }),

    // MedianUpdated events are used for health checks and don't send notifications
    // The handler is registered separately as a special handler
    getDiscordMessage: () => {
      throw new Error("MedianUpdated events should not send Discord messages");
    },

    getTelegramMessage: () => {
      throw new Error("MedianUpdated events should not send Telegram messages");
    },

    emoji: "🏥",
    deduplicationStrategy: "rateFeedId",
  } as EventConfig<QuicknodeEvent & MedianUpdatedEvent>,
} as const;
