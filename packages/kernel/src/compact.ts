import type { ModelProvider, ProviderMessage } from "@minerva/providers";
import { now } from "./events";
import type { Session } from "./session";

const SUMMARIZE_SYSTEM =
  "You are summarizing a coding-agent session so it can continue in a fresh " +
  "context window. Capture: the user's goals and constraints, what was done " +
  "(files touched, commands run, decisions made), current state, and any " +
  "unfinished work or known problems. Be specific about file paths and names. " +
  "Respond with the summary only.";

const SUMMARIZE_PROMPT =
  "Summarize this session now, following your instructions. Remember: " +
  "summary only, no preamble.";

/** The message that stands in for compacted history, shared with replay. */
export function compactedContextMessage(summary: string): ProviderMessage {
  return {
    role: "user",
    content: `[This session was compacted. Summary of the conversation so far:]\n\n${summary}`,
  };
}

/**
 * Manual /compact (design decision #7 scope for v1): one summarization turn,
 * then the model context is replaced by the summary. The event log keeps the
 * full history — compaction changes what the model sees, not the record.
 */
export async function runCompact(session: Session, provider: ModelProvider): Promise<string> {
  const signal = session.beginPrompt();
  try {
    let summary = "";
    let streamError: unknown;
    const stream = provider.streamTurn({
      system: SUMMARIZE_SYSTEM,
      messages: [...session.messages, { role: "user", content: SUMMARIZE_PROMPT }],
      tools: [],
      abortSignal: signal,
    });
    for await (const event of stream) {
      if (event.type === "text-delta") summary += event.text;
      if (event.type === "error") streamError = event.error;
    }
    if (streamError !== undefined) {
      throw streamError instanceof Error ? streamError : new Error(String(streamError));
    }
    summary = summary.trim();
    if (!summary) throw new Error("compaction produced an empty summary");

    session.append({ type: "session.compacted", summary, at: now() });
    await session.flush();
    session.messages.length = 0;
    session.messages.push(compactedContextMessage(summary));
    return summary;
  } finally {
    session.endPrompt();
  }
}
