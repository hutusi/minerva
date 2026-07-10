import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAiSdkProvider, type TurnEvent } from "../src";

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("AI SDK provider adapter", () => {
  test("streams text deltas and a finish event", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello" },
            { type: "text-delta", id: "t1", delta: " world" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
          ],
        }),
      }),
    });
    const provider = createAiSdkProvider(model, "mock");

    const events = await collect(
      provider.streamTurn({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 10 } },
    ]);
  });

  test("surfaces tool calls with parsed input", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              input: JSON.stringify({ path: "src/index.ts" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: USAGE,
            },
          ],
        }),
      }),
    });
    const provider = createAiSdkProvider(model, "mock");

    const events = await collect(
      provider.streamTurn({
        messages: [{ role: "user", content: "read the entrypoint" }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
    );

    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "src/index.ts" },
    });
    expect(events[1]).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  test("converts assistant tool calls and tool results into the prompt", async () => {
    let seenPrompt: unknown;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        seenPrompt = options.prompt;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
            ],
          }),
        };
      },
    });
    const provider = createAiSdkProvider(model, "mock");

    await collect(
      provider.streamTurn({
        system: "be terse",
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            text: "Listing now.",
            toolCalls: [{ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }],
          },
          {
            role: "tool",
            results: [{ toolCallId: "c1", toolName: "bash", output: "README.md" }],
          },
        ],
        tools: [{ name: "bash", description: "Run a command", inputSchema: { type: "object" } }],
      }),
    );

    const prompt = seenPrompt as Array<{ role: string; content: unknown }>;
    const roles = prompt.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(JSON.stringify(prompt)).toContain('"toolCallId":"c1"');
    expect(JSON.stringify(prompt)).toContain("README.md");
  });
});
