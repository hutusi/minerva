import type { ModelProvider, ProviderMessage, TurnUsage } from "@minerva/providers";
import { now } from "./events";
import type { Session } from "./session";

export interface CompactResult {
  summary: string;
  /** Tokens the summarization turn spent, so the caller can notify the client. */
  usage?: TurnUsage;
}

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
export async function runCompact(
  session: Session,
  provider: ModelProvider,
): Promise<CompactResult> {
  const signal = session.beginPrompt();
  try {
    let summary = "";
    let streamError: unknown;
    let turnUsage: TurnUsage | undefined;
    const stream = provider.streamTurn({
      system: SUMMARIZE_SYSTEM,
      messages: [...session.messages, { role: "user", content: SUMMARIZE_PROMPT }],
      tools: [],
      abortSignal: signal,
      // The summary discards reasoning; don't pay for (or stall on) a thinking
      // phase the endpoint would otherwise run when the provider enables it.
      thinking: "off",
    });
    for await (const event of stream) {
      if (event.type === "text-delta") summary += event.text;
      if (event.type === "error") streamError = event.error;
      // The summarization turn spends tokens too; account for them so session
      // usage isn't understated after a compaction.
      if (event.type === "finish") turnUsage = event.usage;
    }
    if (streamError !== undefined) {
      throw streamError instanceof Error ? streamError : new Error(String(streamError));
    }
    summary = summary.trim();
    if (!summary) throw new Error("compaction produced an empty summary");

    if (turnUsage) session.addTurnUsage(turnUsage);
    // Persist the spend on the event so replay can restore it — the summary
    // message alone carries no token count.
    session.append({
      type: "session.compacted",
      summary,
      ...(turnUsage ? { usage: turnUsage } : {}),
      at: now(),
    });
    await session.flush();
    session.messages.length = 0;
    session.messages.push(compactedContextMessage(summary));
    // Reset the auto-compaction signal: the summarization turn's own input
    // is ≈ the over-threshold context, and leaving it set would re-trigger
    // compaction on every following prompt (the loop hazard).
    session.lastTurnContext = undefined;
    return turnUsage ? { summary, usage: turnUsage } : { summary };
  } finally {
    session.endPrompt();
  }
}
