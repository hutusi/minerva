import type { StopReason } from "@minerva/protocol";

/** A turn shorter than this never notifies — the user hasn't left yet. */
export const NOTIFY_MIN_TURN_MS = 5_000;

export interface NotifyInput {
  stopReason: StopReason;
  /** Whether the window had focus when the turn finished. */
  focused: boolean;
  durationMs: number;
  muted: boolean;
  /** Project (tab) name for the body. */
  project: string;
}

/**
 * Whether a finished turn deserves a native notification, and its content.
 * Pure so the matrix is unit-testable; the caller does the OS delivery.
 * Cancelled turns never notify — the user caused them.
 */
export function decideNotification(input: NotifyInput): { title: string; body: string } | null {
  if (input.muted || input.focused || input.stopReason === "cancelled") return null;
  if (input.durationMs < NOTIFY_MIN_TURN_MS) return null;
  const title =
    input.stopReason === "end_turn" ? "Minerva finished a turn" : "Minerva needs attention";
  const detail =
    input.stopReason === "end_turn"
      ? "The reply is ready."
      : input.stopReason === "max_tokens"
        ? "The turn hit the output-token limit."
        : input.stopReason === "max_turn_requests"
          ? "The turn hit the request limit."
          : "The model refused the request.";
  return { title, body: `${input.project} — ${detail}` };
}
