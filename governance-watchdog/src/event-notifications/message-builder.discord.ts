import { EmbedBuilder } from "discord.js";
import { MessageBuilder } from "./message-builder.base";

/**
 * Theme configuration for different event types
 */
interface MessageTheme {
  color: number;
  title: string;
}

/**
 * Discord message builder for proposal events
 * Extends MessageBuilder to eliminate duplication with Telegram builder
 */
export class DiscordMessageBuilder extends MessageBuilder<{
  content: string;
  embed: EmbedBuilder;
}> {
  private embed: EmbedBuilder;
  private content: string;

  constructor(theme: MessageTheme, description?: string) {
    super();
    this.embed = new EmbedBuilder().setTitle(theme.title).setColor(theme.color);
    this.content = theme.title;

    if (description) {
      this.embed.setDescription(description);
    }
  }

  /**
   * Platform-specific implementation to add fields to Discord embed
   */
  protected addFieldToStorage(name: string, value: string): void {
    this.embed.addFields({ name, value });
  }

  /**
   * Set custom content
   */
  setContent(content: string): this {
    this.content = content;
    return this;
  }

  /**
   * Build the final message
   */
  build(): { content: string; embed: EmbedBuilder } {
    return {
      content: this.content,
      embed: this.embed,
    };
  }
}
