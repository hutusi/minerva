import type { PlanEntry, StopReason } from "@minerva/protocol";
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
      at: string;
    }
  | { type: "session.resumed"; provider: string; at: string }
  | { type: "session.mode_changed"; modeId: string; at: string }
  | { type: "user.message"; text: string; at: string }
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
  | { type: "tool.result"; toolCallId: string; output: string; isError: boolean; at: string }
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
      rule?: string;
      at: string;
    }
  | { type: "todo.updated"; entries: PlanEntry[]; at: string }
  | { type: "turn.completed"; stopReason: StopReason; usage?: TurnUsage; at: string }
  | { type: "turn.failed"; error: string; at: string };

export function now(): string {
  return new Date().toISOString();
}
