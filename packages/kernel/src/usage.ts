import type { TokenUsage } from "@minerva/protocol";
import type { TurnUsage } from "@minerva/providers";

function addField(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Sum two usage reports. A field stays absent only when absent on both
 * sides, so providers that never report a number don't fabricate zeros.
 */
export function addUsage(total: TurnUsage, turn: TurnUsage | undefined): TurnUsage {
  if (!turn) return total;
  return {
    inputTokens: addField(total.inputTokens, turn.inputTokens),
    outputTokens: addField(total.outputTokens, turn.outputTokens),
    cacheReadTokens: addField(total.cacheReadTokens, turn.cacheReadTokens),
    cacheWriteTokens: addField(total.cacheWriteTokens, turn.cacheWriteTokens),
  };
}

/** True when the report carries at least one concrete number. */
export function hasUsage(usage: TurnUsage | undefined): usage is TurnUsage {
  return (
    usage !== undefined &&
    (usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined)
  );
}

/**
 * How much of the context window one model CALL occupied. The AI SDK's
 * inputTokens is already the total prompt size — Anthropic's adapter adds
 * cache read/creation back onto the raw input_tokens, and OpenAI-compatible
 * prompt_tokens includes cached tokens — so cache fields must NOT be added
 * on top (that double-counts). Feeds the auto-compaction trigger; callers
 * must pass a single call's usage, never a tool-loop's accumulated total.
 */
export function contextSize(usage: TurnUsage | undefined): number | undefined {
  const size = usage?.inputTokens ?? 0;
  return size > 0 ? size : undefined;
}

/** Normalize for the wire: in/out default to 0, cache fields stay optional. */
export function toTokenUsage(usage: TurnUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
}
