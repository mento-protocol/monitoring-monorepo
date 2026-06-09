import { MessageBuilder } from "./message-builder.base";

/**
 * Telegram message builder for proposal events
 * Handles both message data construction and HTML formatting
 * Extends MessageBuilder to eliminate duplication with Discord builder
 */
export class TelegramMessageBuilder extends MessageBuilder<
  Record<string, string>
> {
  private fields: Record<string, string> = {};
  private introText: string | null = null;

  constructor(introText?: string) {
    super();
    if (introText) {
      this.introText = introText;
    }
  }

  /**
   * Platform-specific implementation to add fields to Telegram message
   */
  protected addFieldToStorage(name: string, value: string): void {
    this.fields[name] = value;
  }

  /**
   * Override to use "Proposer Address" label for Telegram
   */
  addProposerLink(proposer: string): this {
    return super.addProposerLink(proposer, "Proposer Address");
  }

  /**
   * Add title field
   */
  addTitle(title: string): this {
    this.fields.Title = title;
    return this;
  }

  /**
   * Build the final message data (for programmatic access)
   */
  build(): Record<string, string> {
    return { ...this.fields };
  }

  /**
   * Format message as HTML for Telegram
   * @param title The title to display at the top of the message
   * @returns Formatted message string with HTML tags
   */
  toHTML(title: string): string {
    let message = `<b>${escapeHTML(title)}</b>\n\n`;

    // Add intro text without a bold key prefix
    if (this.introText) {
      message += `${escapeHTML(this.introText)}\n\n`;
    }

    for (const [key, value] of Object.entries(this.fields)) {
      message += `<b>${escapeHTML(key)}:</b> ${escapeHTML(value)}\n\n`;
    }
    return message;
  }
}

/**
 * Escapes HTML special characters in a string
 * @param text String to escape
 * @returns Escaped string safe for HTML
 */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
