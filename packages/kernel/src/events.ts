import type { PlanEntry, StopReason, ToolCallContent } from "@minerva/protocol";
import type { ProviderToolCall, TurnUsage } from "@minerva/providers";

/**
 * Session event-log entries (design decision #7). The append-only JSONL
 * stream of these events is the source of truth for a session: replaying it
 * must be enough to rebuild model context, re-render any UI, and audit every
 * side effect. Every variant therefore carries the full fact, not a diff.
 */

export type SessionEvent =
  | {
      type: "session.created";
      sessionId: string;
      cwd: string;
      provider: string;
      /** Profile name the session was created with; body re-resolves on load. */
      profile?: string | undefined;
      at: string;
    }
  | { type: "session.resumed"; provider: string; at: string }
  | { type: "session.mode_changed"; modeId: string; at: string }
  /** The active profile switched (null = cleared). Only the NAME is logged;
   * load re-resolves it against current settings so edits take effect. */
  | { type: "session.profile_changed"; profile: string | null; at: string }
  // Audit trail for a live model switch (minerva/config/set_model). Replay
  // skips unknown/informational events, so logs carrying it stay resumable.
  | { type: "session.model_changed"; provider: string; at: string }
  | {
      type: "user.message";
      /** What the user typed — the transcript/UI text. */
      text: string;
      /**
       * What the model receives instead of `text`, when they differ — e.g. a
       * `/skill` invocation expanded to the skill's instructions. Absent for
       * ordinary prompts; replay falls back to `text`.
       */
      providerText?: string | undefined;
      at: string;
    }
  | {
      /**
       * Reasoning the model streamed before answering. Display-only: replay
       * re-renders it but never feeds it back into provider messages.
       */
      type: "assistant.thought";
      text: string;
      at: string;
    }
  | {
      type: "assistant.message";
      text: string;
      /**
       * Tool calls issued in this assistant turn. Duplicates tool.call events
       * on purpose: this event alone must reconstruct the provider message on
       * replay, including calls the model made with no accompanying text.
       */
      toolCalls: ProviderToolCall[];
      at: string;
    }
  | { type: "tool.call"; toolCallId: string; toolName: string; input: unknown; at: string }
  | {
      type: "tool.result";
      toolCallId: string;
      output: string;
      isError: boolean;
      /**
       * Structured blocks (file diffs) the tool emitted alongside its text
       * output, so replay re-renders them. Optional: old logs replay
       * unchanged, and text-only results add no field.
       */
      content?: ToolCallContent[] | undefined;
      at: string;
    }
  | {
      type: "permission.decision";
      toolCallId: string;
      toolName: string;
      decision: "allowed" | "denied";
      /**
       * "policy" = kernel rules/modes; "user" = explicit user choice via
       * permission request; "frontend" = the frontend answered without a user
       * choice (cancelled outcome); "error" = the request failed, denied by
       * default.
       */
      source: "policy" | "user" | "frontend" | "error";
      /** The permission rule that decided, when one matched. */
      rule?: string | undefined;
      at: string;
    }
  | { type: "todo.updated"; entries: PlanEntry[]; at: string }
  | {
      /**
       * Model context was reset to a summary. Replay rebuilds the compacted
       * context from this event; the UI transcript keeps the full history.
       */
      type: "session.compacted";
      summary: string;
      /** Tokens the summarization turn itself spent, so replay can restore
       * the session total (which the summary message alone can't). */
      usage?: TurnUsage | undefined;
      at: string;
    }
  | { type: "turn.completed"; stopReason: StopReason; usage?: TurnUsage | undefined; at: string }
  | { type: "turn.failed"; error: string; at: string };

export function now(): string {
  return new Date().toISOString();
}
