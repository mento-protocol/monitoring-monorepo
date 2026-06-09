import assert from "assert/strict";
import { EmbedBuilder } from "discord.js";
import sendDiscordNotification from "../event-notifications/send-discord-notification.js";
import sendTelegramNotification from "../event-notifications/send-telegram-notification.js";
import { EventType, QuicknodeEvent } from "./types.js";
import { createEventTitle } from "./utils/create-event-title.js";

/**
 * Configuration interface for event handlers
 */
export interface EventHandlerConfig<T extends QuicknodeEvent> {
  eventType: EventType;
  validateEvent: (event: unknown) => event is T;
  getDiscordMessage: (event: T) => { content: string; embed: EmbedBuilder };
  getTelegramMessage: (event: T) => { toHTML: (title: string) => string };
  emoji: string;
}

/**
 * Creates a generic event handler that eliminates code duplication
 */
export function createEventHandler<T extends QuicknodeEvent>(
  config: EventHandlerConfig<T>,
) {
  return async function handleEvent(event: QuicknodeEvent): Promise<void> {
    // Helper to safely stringify events that may contain bigints
    const safeStringify = (obj: unknown): string => {
      try {
        return JSON.stringify(obj, (_, value: unknown): unknown =>
          typeof value === "bigint" ? value.toString() : value,
        );
      } catch {
        return String(obj);
      }
    };

    assert(
      config.validateEvent(event),
      `Expected ${config.eventType} event but was ${safeStringify(event)}`,
    );

    console.info(`${config.eventType} event found at block`, event.blockNumber);

    // Send Discord notification
    try {
      console.info(
        `🌀 Sending Discord notification for ${config.eventType} event...`,
      );
      const discordMsg = config.getDiscordMessage(event);
      await sendDiscordNotification(discordMsg.content, discordMsg.embed);
      console.info(
        `✅ Successfully sent Discord notification for ${config.eventType} event`,
      );
    } catch (error) {
      console.error(
        `❌ Failed to send Discord notification for ${config.eventType} event:`,
        error,
      );
    }

    // Send Telegram notification
    try {
      console.info(
        `🌀 Sending Telegram notification for ${config.eventType} event...`,
      );
      const messageBuilder = config.getTelegramMessage(event);
      const title = createEventTitle(config.emoji, config.eventType);
      const formattedMessage = messageBuilder.toHTML(title);
      await sendTelegramNotification(formattedMessage);
      console.info(
        `✅ Successfully sent Telegram notification for ${config.eventType} event`,
      );
    } catch (error) {
      console.error(
        `❌ Failed to send Telegram notification for ${config.eventType} event:`,
        error,
      );
    }
  };
}
