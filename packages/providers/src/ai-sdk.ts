/**
 * AI SDK adapter — the only module in Minerva that imports `ai`.
 * The kernel never sees AI SDK types; everything crosses the boundary as
 * the kernel-owned shapes in ./types.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import type {
  ModelProvider,
  ProviderMessage,
  ToolDefinition,
  TurnEvent,
  TurnFinishReason,
} from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

export interface AnthropicProviderOptions {
  model?: string;
  apiKey?: string;
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const modelId = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const anthropic = createAnthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  return createAiSdkProvider(anthropic(modelId), `anthropic/${modelId}`);
}

/** Wrap any AI SDK language model (including mocks in tests). */
export function createAiSdkProvider(model: LanguageModel, id: string): ModelProvider {
  return {
    id,
    async *streamTurn(request) {
      const result = streamText({
        model,
        system: request.system,
        messages: request.messages.map(toModelMessage),
        tools: toToolSet(request.tools),
        abortSignal: request.abortSignal,
      });

      for await (const part of result.fullStream) {
        const event = toTurnEvent(part);
        if (event) yield event;
      }
    },
  };
}

function toToolSet(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const def of tools) {
    // No `execute`: the kernel runs tools itself (permissions, audit log),
    // so the model turn always ends at the tool-call boundary.
    set[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
    });
  }
  return set;
}

function toModelMessage(message: ProviderMessage): ModelMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
        ],
      };
    case "tool":
      return {
        role: "tool",
        content: message.results.map((result) => ({
          type: "tool-result" as const,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result.isError
            ? { type: "error-text" as const, value: result.output }
            : { type: "text" as const, value: result.output },
        })),
      };
  }
}

type StreamPart =
  Awaited<ReturnType<typeof streamText>>["fullStream"] extends AsyncIterable<infer P> ? P : never;

function toTurnEvent(part: StreamPart): TurnEvent | null {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case "finish":
      return {
        type: "finish",
        finishReason: toFinishReason(part.finishReason),
        usage: {
          inputTokens: part.totalUsage.inputTokens,
          outputTokens: part.totalUsage.outputTokens,
        },
      };
    case "error":
      return { type: "error", error: part.error };
    default:
      return null;
  }
}

function toFinishReason(reason: string): TurnFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool-calls";
    case "length":
      return "length";
    default:
      return "other";
  }
}
