/**
 * Kernel-owned model abstraction. The kernel drives the agent loop and talks
 * only to these types; how a turn reaches an actual LLM (AI SDK, mock,
 * future direct adapters) is an implementation detail behind ModelProvider.
 */

/** A tool as the model sees it. inputSchema is JSON Schema (draft-07 subset). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ProviderToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}

export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ProviderToolCall[] }
  | { role: "tool"; results: ProviderToolResult[] };

export interface TurnRequest {
  system?: string | undefined;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  abortSignal?: AbortSignal | undefined;
  /**
   * "off" suppresses reasoning for this call even if the provider was
   * configured to think — used by /compact, whose summary discards reasoning.
   * Providers without a thinking toggle ignore it.
   */
  thinking?: "off" | undefined;
}

export interface TurnUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

export type TurnFinishReason = "stop" | "tool-calls" | "length" | "other";

export type TurnEvent =
  | { type: "text-delta"; text: string }
  // Marks the start of a reasoning block. Carries no text; it exists so the
  // kernel can separate consecutive reasoning blocks that would otherwise
  // concatenate into one run-on thought.
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; finishReason: TurnFinishReason; usage: TurnUsage }
  | { type: "error"; error: unknown };

export interface ModelProvider {
  /** Stable identifier, e.g. "anthropic/claude-opus-4-8". */
  readonly id: string;
  /**
   * The model's context window in tokens, when known. Feeds auto-compaction;
   * absent means "unknown" and features that need it stay inert.
   */
  readonly contextWindow?: number | undefined;
  /** Stream one model turn. Ends with a "finish" or "error" event. */
  streamTurn(request: TurnRequest): AsyncIterable<TurnEvent>;
}
