import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  PROTOCOL_VERSION,
  type RequestPermissionParams,
  type SessionUpdateBatchParams,
  type SessionUpdateParams,
  type SessionUsageParams,
} from "@minerva/protocol";
import { createScriptedProvider, type TurnEvent } from "@minerva/providers";
import { createKernel, type SessionEvent } from "../src";

const FINISH_TOOLS: TurnEvent = {
  type: "finish",
  finishReason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 5 },
};
const FINISH_STOP: TurnEvent = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 20, outputTokens: 8 },
};

interface Harness {
  client: Connection;
  updates: SessionUpdateParams[];
  usageNotices: SessionUsageParams[];
  permissionRequests: RequestPermissionParams[];
  sessionId: string;
  cwd: string;
  logEvents: () => SessionEvent[];
  sessionMessages: () => unknown[];
}

async function setup(options: {
  turns: TurnEvent[][];
  permission?: "allow" | "allow_always" | "reject" | "cancel";
  /** Declare a context window on the scripted provider (arms usage_update). */
  contextWindow?: number;
}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-data-"));
  writeFileSync(join(cwd, "hello.txt"), "hi from disk\n");

  const scripted = createScriptedProvider(options.turns);
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    provider:
      options.contextWindow !== undefined
        ? { ...scripted, contextWindow: options.contextWindow }
        : scripted,
    dataDir,
  });

  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  const usageNotices: SessionUsageParams[] = [];
  const permissionRequests: RequestPermissionParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  // Replay arrives as one batch; flatten it so the per-update assertions below
  // see the same sequence they would from individual notifications.
  client.handleNotification(CLIENT_METHODS.sessionUpdateBatch, (params) => {
    const { sessionId, updates: batch } = params as SessionUpdateBatchParams;
    for (const update of batch) updates.push({ sessionId, update });
  });
  client.handleNotification(CLIENT_METHODS.sessionUsage, (params) => {
    usageNotices.push(params as SessionUsageParams);
  });
  client.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) => {
    permissionRequests.push(params as RequestPermissionParams);
    if (options.permission === "cancel") {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: options.permission ?? "allow" },
    };
  });

  const init = await client.request<{ protocolVersion: number }>(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
  });
  expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

  const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
    cwd,
  });

  return {
    client,
    updates,
    usageNotices,
    permissionRequests,
    sessionId,
    cwd,
    logEvents: () => {
      const logPath = kernel.getSession(sessionId)?.logPath;
      if (!logPath) throw new Error("session log not found");
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SessionEvent);
    },
    sessionMessages: () => {
      const session = kernel.getSession(sessionId);
      if (!session) throw new Error("session not found");
      return session.messages as unknown[];
    },
  };
}

function prompt(harness: Harness, text: string) {
  return harness.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
    sessionId: harness.sessionId,
    prompt: [{ type: "text", text }],
  });
}

describe("kernel over in-proc transport", () => {
  test("full loop: streamed text, approved bash call, event log audit trail", async () => {
    const harness = await setup({
      turns: [
        [
          { type: "text-delta", text: "Running " },
          { type: "text-delta", text: "a command." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo from-tool" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "All done." }, FINISH_STOP],
      ],
    });

    const result = await prompt(harness, "run something");
    expect(result.stopReason).toBe("end_turn");

    const kinds = harness.updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update", // in_progress
      "tool_call_update", // completed
      "agent_message_chunk",
    ]);
    const completed = harness.updates[4]?.update;
    expect(completed).toMatchObject({ toolCallId: "c1", status: "completed" });
    expect(JSON.stringify(completed)).toContain("from-tool");
    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]?.toolCall.title).toBe("echo from-tool");

    const eventTypes = harness.logEvents().map((event) => event.type);
    expect(eventTypes).toEqual([
      "session.created",
      "user.message",
      "assistant.message",
      "tool.call",
      "permission.decision",
      "tool.result",
      "assistant.message",
      "turn.completed",
    ]);
    const decision = harness.logEvents()[4];
    expect(decision).toMatchObject({ decision: "allowed", source: "user", toolName: "bash" });

    // Usage must be summed across both model turns (tool round-trip + final
    // answer), not just the last one.
    expect(harness.logEvents().at(-1)).toMatchObject({
      type: "turn.completed",
      usage: { inputTokens: 30, outputTokens: 13 },
    });
    expect(harness.usageNotices).toEqual([
      {
        sessionId: harness.sessionId,
        lastTurn: { inputTokens: 30, outputTokens: 13 },
        cumulative: { inputTokens: 30, outputTokens: 13 },
      },
    ]);
  });

  test("reasoning streams as thought chunks, persists, and replays before the answer", async () => {
    const harness = await setup({
      turns: [
        [
          { type: "reasoning-delta", text: "Consider " },
          { type: "reasoning-delta", text: "carefully." },
          { type: "text-delta", text: "Answer." },
          FINISH_STOP,
        ],
      ],
    });

    const result = await prompt(harness, "think about it");
    expect(result.stopReason).toBe("end_turn");

    expect(harness.updates.map((u) => u.update.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
    ]);
    expect(harness.logEvents().map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "assistant.thought",
      "assistant.message",
      "turn.completed",
    ]);
    expect(harness.logEvents()[2]).toMatchObject({
      type: "assistant.thought",
      text: "Consider carefully.",
    });
    // Thoughts are display-only — provider history must not include them.
    expect(harness.sessionMessages().map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
    ]);

    // Resume re-renders the thought ahead of the turn's message text.
    harness.updates.length = 0;
    await harness.client.request(AGENT_METHODS.sessionLoad, {
      sessionId: harness.sessionId,
      cwd: harness.cwd,
    });
    expect(harness.updates.map((u) => u.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
    ]);
  });

  test("consecutive reasoning blocks are separated by a blank line", async () => {
    const harness = await setup({
      turns: [
        [
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "First block." },
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "Second block." },
          { type: "text-delta", text: "Answer." },
          FINISH_STOP,
        ],
      ],
    });

    const result = await prompt(harness, "reason in two blocks");
    expect(result.stopReason).toBe("end_turn");

    // Persisted thought carries the blank-line boundary between blocks.
    const thought = harness.logEvents().find((event) => event.type === "assistant.thought");
    expect(thought).toMatchObject({ text: "First block.\n\nSecond block." });

    // Streamed chunks concatenate to exactly the persisted thought.
    const streamed = harness.updates
      .filter((u) => u.update.sessionUpdate === "agent_thought_chunk")
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join("");
    expect(streamed).toBe("First block.\n\nSecond block.");
  });

  test("a thought-only turn records an assistant message so roles stay alternating", async () => {
    const harness = await setup({
      turns: [
        // Reasoning burned the whole budget: no text, no tool calls.
        [{ type: "reasoning-delta", text: "Only thinking." }, FINISH_STOP],
        [{ type: "text-delta", text: "Now answering." }, FINISH_STOP],
      ],
    });

    const first = await prompt(harness, "first");
    expect(first.stopReason).toBe("end_turn");
    // The empty assistant message closes the turn; the trailing thought
    // follows it. Replay emits nothing for the empty message, so the user
    // still sees only the thought.
    expect(harness.logEvents().map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "assistant.message",
      "assistant.thought",
      "turn.completed",
    ]);
    expect(harness.logEvents().find((e) => e.type === "assistant.message")).toMatchObject({
      text: "",
    });
    // An empty assistant message keeps the provider history alternating; a
    // second prompt must not produce two consecutive user messages.
    expect(harness.sessionMessages().map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
    ]);

    const second = await prompt(harness, "second");
    expect(second.stopReason).toBe("end_turn");
    expect(harness.sessionMessages().map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("a thought that streams after the answer is logged and replayed in stream order", async () => {
    const harness = await setup({
      turns: [
        [
          { type: "text-delta", text: "Answer." },
          { type: "reasoning-delta", text: "Afterthought." },
          FINISH_STOP,
        ],
      ],
    });

    const result = await prompt(harness, "answer then reflect");
    expect(result.stopReason).toBe("end_turn");

    // Live stream order: the message chunk streamed before the thought chunk.
    expect(harness.updates.map((u) => u.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_thought_chunk",
    ]);
    // The log preserves that order: message ahead of the trailing thought.
    expect(harness.logEvents().map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "assistant.message",
      "assistant.thought",
      "turn.completed",
    ]);

    // Resume re-renders them in the same order the user watched.
    harness.updates.length = 0;
    await harness.client.request(AGENT_METHODS.sessionLoad, {
      sessionId: harness.sessionId,
      cwd: harness.cwd,
    });
    expect(harness.updates.map((u) => u.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
    ]);
  });

  test("a thought before a cancelled tool call still lands in the log", async () => {
    const harness = await setup({
      permission: "cancel",
      turns: [
        [
          { type: "reasoning-delta", text: "Should I run it?" },
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "echo hi" } },
          FINISH_TOOLS,
        ],
      ],
    });

    const result = await prompt(harness, "run something");
    expect(result.stopReason).toBe("cancelled");

    const types = harness.logEvents().map((event) => event.type);
    expect(types.indexOf("assistant.thought")).toBeGreaterThan(-1);
    expect(types.indexOf("assistant.thought")).toBeLessThan(types.indexOf("assistant.message"));
    expect(harness.logEvents().find((event) => event.type === "assistant.thought")).toMatchObject({
      text: "Should I run it?",
    });
  });

  test("usage accumulates across prompts and is re-announced on resume", async () => {
    const harness = await setup({
      turns: [
        [{ type: "text-delta", text: "one" }, FINISH_STOP],
        [{ type: "text-delta", text: "two" }, FINISH_STOP],
      ],
    });

    await prompt(harness, "first");
    await prompt(harness, "second");
    expect(harness.usageNotices.map((n) => n.cumulative)).toEqual([
      { inputTokens: 20, outputTokens: 8 },
      { inputTokens: 40, outputTokens: 16 },
    ]);

    // Resume rebuilds session-lifetime totals from the log and re-announces
    // them without a lastTurn.
    harness.usageNotices.length = 0;
    await harness.client.request(AGENT_METHODS.sessionLoad, {
      sessionId: harness.sessionId,
      cwd: harness.cwd,
    });
    expect(harness.usageNotices).toEqual([
      { sessionId: harness.sessionId, cumulative: { inputTokens: 40, outputTokens: 16 } },
    ]);
  });

  test("usage_update: emitted with a declared context window, live and on load", async () => {
    const harness = await setup({
      turns: [[{ type: "text-delta", text: "hi" }, FINISH_STOP]],
      contextWindow: 1_000,
    });

    await prompt(harness, "hello");
    const expected = {
      sessionId: harness.sessionId,
      update: { sessionUpdate: "usage_update", used: 20, size: 1_000 },
    } as const;
    expect(harness.updates.filter((u) => u.update.sessionUpdate === "usage_update")).toEqual([
      expected,
    ]);

    // Resume rebuilds lastTurnContext from the log and re-announces the
    // meter so a frontend shows it before the next turn.
    harness.updates.length = 0;
    await harness.client.request(AGENT_METHODS.sessionLoad, {
      sessionId: harness.sessionId,
      cwd: harness.cwd,
    });
    expect(harness.updates.filter((u) => u.update.sessionUpdate === "usage_update")).toEqual([
      expected,
    ]);
  });

  test("usage_update: silent when the provider declares no context window", async () => {
    const harness = await setup({
      turns: [[{ type: "text-delta", text: "hi" }, FINISH_STOP]],
    });
    await prompt(harness, "hello");
    // The turn still reports usage — but without a window, utilization
    // would be a guess, so nothing is emitted.
    expect(harness.usageNotices.length).toBe(1);
    expect(harness.updates.some((u) => u.update.sessionUpdate === "usage_update")).toBe(false);
  });

  test("denied permission becomes an error tool result and the loop continues", async () => {
    const harness = await setup({
      permission: "reject",
      turns: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "edit_file",
            input: { path: "hello.txt", old_string: "hi", new_string: "bye" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "Understood, leaving the file alone." }, FINISH_STOP],
      ],
    });

    const result = await prompt(harness, "edit the file");
    expect(result.stopReason).toBe("end_turn");

    const failed = harness.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(failed).toBeDefined();
    const decision = harness.logEvents().find((event) => event.type === "permission.decision");
    expect(decision).toMatchObject({ decision: "denied", source: "user" });
  });

  test("read-only tools bypass the permission request", async () => {
    const harness = await setup({
      turns: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "hello.txt" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "The file says hi." }, FINISH_STOP],
      ],
    });

    await prompt(harness, "what does hello.txt say?");
    expect(harness.permissionRequests).toHaveLength(0);
    const decision = harness.logEvents().find((event) => event.type === "permission.decision");
    expect(decision).toMatchObject({ decision: "allowed", source: "policy" });
    const completed = harness.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("hi from disk");
  });

  test("cancelled permission outcome ends the turn with no dangling tool_use", async () => {
    const harness = await setup({
      permission: "cancel",
      turns: [
        [
          { type: "text-delta", text: "Editing now." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "edit_file",
            input: { path: "hello.txt", old_string: "hi", new_string: "bye" },
          },
          FINISH_TOOLS,
        ],
      ],
    });

    const result = await prompt(harness, "edit the file");
    expect(result.stopReason).toBe("cancelled");

    // ACP cancelled outcome is not a user denial and must be audited as such.
    const decision = harness.logEvents().find((event) => event.type === "permission.decision");
    expect(decision).toMatchObject({ decision: "denied", source: "frontend" });

    // Every tool_use in the pushed assistant message has a matching result,
    // so the next prompt in this session sends a well-formed history.
    const messages = harness.sessionMessages() as Array<{
      role: string;
      toolCalls?: unknown[];
      results?: Array<{ toolCallId: string }>;
    }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[2]?.results?.map((r) => r.toolCallId)).toEqual(["c1"]);

    // The streamed assistant text survived cancellation into the event log.
    const assistant = harness.logEvents().find((event) => event.type === "assistant.message");
    expect(assistant).toMatchObject({ text: "Editing now." });
  });

  test("allow_always persists a rule and later identical calls skip the prompt", async () => {
    const call = (id: string): TurnEvent => ({
      type: "tool-call",
      toolCallId: id,
      toolName: "bash",
      input: { command: "echo x" },
    });
    const harness = await setup({
      permission: "allow_always",
      turns: [
        [call("c1"), FINISH_TOOLS],
        [call("c2"), FINISH_TOOLS],
        [{ type: "text-delta", text: "done" }, FINISH_STOP],
      ],
    });

    await prompt(harness, "run it twice");
    expect(harness.permissionRequests).toHaveLength(1);

    const decisions = harness.logEvents().filter((event) => event.type === "permission.decision");
    expect(decisions[0]).toMatchObject({
      decision: "allowed",
      source: "user",
      rule: "bash(echo x)",
    });
    expect(decisions[1]).toMatchObject({
      decision: "allowed",
      source: "policy",
      rule: "bash(echo x)",
    });

    const settings = JSON.parse(
      readFileSync(join(harness.cwd, ".minerva", "settings.json"), "utf8"),
    );
    expect(settings.permissions.allow).toEqual(["bash(echo x)"]);
  });

  test("plan mode denies mutating tools without asking; auto mode allows", async () => {
    const harness = await setup({
      turns: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo blocked" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "ok, planning only" }, FINISH_STOP],
        [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "bash",
            input: { command: "echo allowed" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "ran it" }, FINISH_STOP],
      ],
    });

    await harness.client.request(AGENT_METHODS.sessionSetMode, {
      sessionId: harness.sessionId,
      modeId: "plan",
    });
    await prompt(harness, "try something");
    expect(harness.permissionRequests).toHaveLength(0);
    const denied = harness.logEvents().find((event) => event.type === "permission.decision");
    expect(denied).toMatchObject({ decision: "denied", source: "policy" });
    const failed = harness.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(JSON.stringify(failed)).toContain("plan mode");

    await harness.client.request(AGENT_METHODS.sessionSetMode, {
      sessionId: harness.sessionId,
      modeId: "auto",
    });
    await prompt(harness, "now really run it");
    expect(harness.permissionRequests).toHaveLength(0);
    const completed = harness.updates.filter(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    expect(JSON.stringify(completed)).toContain("allowed");

    const modeEvents = harness.logEvents().filter((event) => event.type === "session.mode_changed");
    expect(modeEvents.map((event) => event.modeId)).toEqual(["plan", "auto"]);
  });

  test("concurrent prompt on the same session is rejected", async () => {
    const harness = await setup({
      turns: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "sleep 0.2" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "done" }, FINISH_STOP],
      ],
    });

    const first = prompt(harness, "slow one");
    await Bun.sleep(20);
    await expect(prompt(harness, "second")).rejects.toThrow("already running");
    await first;
  });
});
