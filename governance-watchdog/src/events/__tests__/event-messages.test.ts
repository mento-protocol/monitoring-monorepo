import { describe, expect, it } from "vitest";
import { EVENT_CONFIGS } from "../configs.js";
import { EventType, type QuicknodeEvent } from "../types.js";
import { createEventTitle } from "../utils/create-event-title.js";
import proposalCanceled from "../fixtures/proposal-canceled.fixture.json";
import proposalCreated from "../fixtures/proposal-created.fixture.json";
import proposalExecuted from "../fixtures/proposal-executed.fixture.json";
import proposalQueued from "../fixtures/proposal-queued.fixture.json";

const CASES = [
  [EventType.ProposalCreated, proposalCreated],
  [EventType.ProposalQueued, proposalQueued],
  [EventType.ProposalExecuted, proposalExecuted],
  [EventType.ProposalCanceled, proposalCanceled],
] as const;

describe.each(CASES)("%s message rendering", (eventType, fixture) => {
  // Fixtures keep bigint-like QuickNode fields as JSON strings, matching
  // production webhook payloads. Builders normalize them at render time.
  const event = fixture.result[0] as unknown as QuicknodeEvent;
  const config = EVENT_CONFIGS[eventType];

  it("validates the committed fixture", () => {
    expect(config.validateEvent(event)).toBe(true);
  });

  it("builds the Discord message", () => {
    const { content, embed } = config.getDiscordMessage(event as never);

    expect({ content, embed: embed.toJSON() }).toMatchSnapshot();
  });

  it("builds the Telegram HTML", () => {
    const title = createEventTitle(config.emoji, config.eventType);

    expect(
      config.getTelegramMessage(event as never).toHTML(title),
    ).toMatchSnapshot();
  });
});
