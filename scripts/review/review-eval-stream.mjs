// The `stream-json` parser and the session envelope every lane is scored from.
//
// This module imports nothing on purpose. The orchestrator runs the cell writer
// out of its sealed source snapshot, and the snapshot holds these files alone,
// so a parser with dependencies would either drag the whole checkout into the
// snapshot or be loaded from the live repository — where it can change between
// two cells of one run while the cell fingerprint stays the same. Keep it
// dependency-free, and keep it in `ORCHESTRATOR_FILES` so the digest binds it.

/**
 * The session text budget, in characters.
 *
 * It is the smaller of the two judge truncations in `review-eval-score.mjs`,
 * which reads this constant rather than its own copy. The judges score the
 * head of the text they are handed, so a session longer than this had its final
 * report cut off and the judges scored interim text instead. Capture is
 * message-aware here instead: the final message always survives, and only whole
 * earlier messages are kept, so the two ends cannot drift apart.
 */
export const SESSION_TEXT_BUDGET_CHARS = 30000;

const MESSAGE_SEPARATOR = "\n\n";

/** The text blocks of one assistant message, in order. */
function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * The assistant messages and the closing `result` event of one `stream-json`
 * session.
 *
 * Sub-agent messages carry a `parent_tool_use_id` and are left out. They are
 * the reviewer's internal delegation, not the report it filed, and folding them
 * into the transcript would put text no reader ever saw in front of the claim
 * extractor. A sub-agent's own `result` event carries the same field and is
 * left out for a stronger reason: it closes the delegation, not the session, so
 * taking it would hand every consumer a sub-agent's cost, turn count and error
 * bit — and, when the sub-agent ran last, its text as the session's answer.
 *
 * `chars` is the length of the stream this parse read. It is the one number
 * that says how close a session came to the caller's output ceiling, which
 * kills the process rather than truncating it.
 *
 * A line that opens like JSON and does not parse throws rather than being
 * skipped: truncated output must fail a cell, not be scored as a shorter
 * review. Lines that do not open like JSON are CLI chatter and are ignored.
 */
export function parseClaudeStream(raw, { label = "claude" } = {}) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const messages = [];
  let result = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${label} wrote a malformed stream event: ${error.message}`,
        { cause: error },
      );
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    if ((event.parent_tool_use_id ?? null) !== null) continue;
    if (event.type === "assistant") {
      const message = assistantText(event.message);
      if (message) messages.push(message);
      continue;
    }
    if (event.type === "result") result = event;
  }
  if (!result) throw new Error(`${label} produced no result event`);
  return { messages, result, chars: text.length };
}

/**
 * The scored text of one session: the final assistant message, plus as many
 * whole messages immediately before it as fit in `budget`.
 *
 * Joining the whole session and letting the judges truncate scored the head of
 * a long session and threw the report away — a reviewer that wrote 40 000
 * characters of working notes before its finding was judged on the notes. The
 * final message is therefore never dropped, and never split: it is kept whole
 * even when it alone exceeds the budget, and the scorer's own truncation then
 * applies to it, exactly as before. Earlier messages are added newest-first and
 * stop at the first one that does not fit, so the kept text stays a contiguous
 * tail of the session rather than a sampled one.
 */
export function sessionText(messages, budget = SESSION_TEXT_BUDGET_CHARS) {
  const all = Array.isArray(messages) ? messages : [];
  if (all.length === 0) return { text: "", kept: 0 };
  let used = all.at(-1).length;
  let first = all.length - 1;
  for (let index = all.length - 2; index >= 0; index -= 1) {
    const next = used + MESSAGE_SEPARATOR.length + all[index].length;
    if (next > budget) break;
    used = next;
    first = index;
  }
  return {
    text: all.slice(first).join(MESSAGE_SEPARATOR),
    kept: all.length - first,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One `--output-format json` envelope, rebuilt from the session stream.
 *
 * Every consumer of a contestant or judge call reads this shape, so the four
 * fields the CLI put in its envelope — `total_cost_usd`, `num_turns`,
 * `is_error`, `session_id` and `duration_ms` — carry over from the closing
 * `result` event unchanged, and `result` stays the field that holds the text.
 *
 * `resultText` decides which text that is. A contestant is scored on its
 * session (`"session"`), trimmed to the judge budget by `sessionText()`. A
 * judge answers in its last message (`"final"`), and the judge parsers slice
 * one JSON object out of that text, so an earlier message's stray brace would
 * break the slice. `final_result`, `assistant_messages` and
 * `assistant_messages_kept` keep the discarded half, the message count and how
 * many of those messages the scored text carries visible for evidence.
 *
 * `stream_chars` is the size of the stream those fields were read from. The
 * caller kills a session that writes more than its output ceiling, so a cell
 * that scored oddly can be checked against the ceiling it ran under instead of
 * guessing whether it came close.
 */
export function claudeStreamEnvelope(
  raw,
  { label = "claude", resultText = "session", budget } = {},
) {
  const { messages, result, chars } = parseClaudeStream(raw, { label });
  const finalText =
    typeof result.result === "string" && result.result.trim()
      ? result.result
      : (messages.at(-1) ?? "");
  const session = sessionText(messages, budget ?? SESSION_TEXT_BUDGET_CHARS);
  const final = resultText === "final";
  return {
    result: final ? finalText : session.text,
    final_result: finalText,
    assistant_messages: messages.length,
    assistant_messages_kept: final ? (finalText ? 1 : 0) : session.kept,
    stream_chars: chars,
    total_cost_usd: finiteNumber(result.total_cost_usd) ?? 0,
    num_turns: Number.isInteger(result.num_turns) ? result.num_turns : null,
    // A result event that does not say it succeeded is an error. The CLI always
    // carries the field; a stream that lost it lost the one bit that separates
    // a finished review from a truncated one.
    is_error: result.is_error !== false,
    session_id:
      typeof result.session_id === "string" ? result.session_id : null,
    duration_ms: finiteNumber(result.duration_ms),
  };
}

/**
 * The same envelope, read from one `codex exec --json` session.
 *
 * A codex verifier is the probe lane's second substitution, and the scorer,
 * the judge and the evidence validator all read the shape above, so this
 * produces that shape rather than a second one. The mapping is:
 *
 * - an agent message is `item.completed` carrying an `agent_message` item,
 *   which is the only event that holds text the reviewer wrote;
 * - the scored text is the same message-aware session tail `claudeStreamEnvelope`
 *   scores, so a codex cell and a claude cell are judged on the same budget;
 * - `lastMessage` is what `codex exec -o FILE` wrote. It is the final agent
 *   message, and it is preferred for `final_result` because a session whose
 *   last event was lost still recorded its answer there;
 * - `num_turns` counts the `turn.completed` events;
 * - a session with no completed turn, or one that reports `turn.failed` or an
 *   `error` event, is an error.
 *
 * `total_cost_usd` is 0 because the CLI reports tokens and no price. A probe
 * under a codex verifier is therefore unmetered, and the cell says so with
 * `cost_metered: false` rather than implying the call was free.
 */
export function codexStreamEnvelope(
  raw,
  { label = "codex", lastMessage = "", budget } = {},
) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const messages = [];
  let turns = 0;
  let failed = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${label} wrote a malformed stream event: ${error.message}`,
        { cause: error },
      );
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    if (event.type === "turn.completed") turns += 1;
    if (event.type === "turn.failed" || event.type === "error") failed = true;
    if (event.type !== "item.completed") continue;
    if (event.item?.type !== "agent_message") continue;
    const message = String(event.item?.text ?? "").trim();
    if (message) messages.push(message);
  }
  const tail = String(lastMessage ?? "").trim();
  // The file is the authority on the final message: an agent message the
  // stream lost would otherwise drop the answer the cell paid for.
  if (tail && messages.at(-1) !== tail) messages.push(tail);
  const session = sessionText(messages, budget ?? SESSION_TEXT_BUDGET_CHARS);
  return {
    result: session.text,
    final_result: tail || (messages.at(-1) ?? ""),
    assistant_messages: messages.length,
    assistant_messages_kept: session.kept,
    stream_chars: text.length,
    total_cost_usd: 0,
    cost_metered: false,
    num_turns: turns > 0 ? turns : null,
    is_error: failed || turns === 0 || messages.length === 0,
    session_id: null,
    duration_ms: null,
  };
}
