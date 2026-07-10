import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  type SessionUpdateParams,
} from "@minerva/protocol";
import type { ModelProvider, TurnEvent } from "@minerva/providers";
import { createScriptedProvider } from "@minerva/providers";
import {
  bashTool,
  createKernel,
  defaultRuntime,
  editFileTool,
  globTool,
  grepTool,
  loadSettings,
  readFileTool,
  replayEvents,
  type SessionEvent,
  todoTool,
  writeFileTool,
} from "../src";

const FINISH_TOOLS: TurnEvent = { type: "finish", finishReason: "tool-calls", usage: {} };
const FINISH_STOP: TurnEvent = { type: "finish", finishReason: "stop", usage: {} };

function harness(provider: ModelProvider) {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-gaps-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-gaps-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, { dataDir, provider });
  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  client.handleRequest(CLIENT_METHODS.sessionRequestPermission, () => ({
    outcome: { outcome: "selected", optionId: "allow" },
  }));
  return { cwd, kernel, client, updates };
}

describe("tool titles", () => {
  test("every built-in produces a human title from valid input", () => {
    expect(readFileTool.title({ path: "a.ts" })).toBe("Read a.ts");
    expect(writeFileTool.title({ path: "b.ts" })).toBe("Write b.ts");
    expect(editFileTool.title({ path: "c.ts" })).toBe("Edit c.ts");
    expect(globTool.title({ pattern: "**/*.ts" })).toBe("Glob **/*.ts");
    expect(grepTool.title({ pattern: "TODO" })).toBe("Grep /TODO/");
    expect(bashTool.title({ command: "ls -la" })).toBe("ls -la");
    expect(todoTool.title({ todos: [{ content: "x", status: "completed" }] })).toBe(
      "Update todos (1/1 done)",
    );
  });

  test("titles throw on malformed input (the loop falls back to the tool name)", () => {
    expect(() => bashTool.title({})).toThrow();
    expect(() => todoTool.title({ todos: "nope" })).toThrow();
  });
});

describe("runtime + settings edges", () => {
  test("exec rejects when the spawn itself fails (bad cwd)", async () => {
    await expect(
      defaultRuntime.exec("echo hi", { cwd: "/nonexistent-dir-xyz", timeoutMs: 5000 }),
    ).rejects.toThrow();
  });

  test("todo_write without a loop hook fails loudly", async () => {
    await expect(
      todoTool.execute(
        { todos: [] },
        { cwd: mkdtempSync(join(tmpdir(), "gaps-")), runtime: defaultRuntime },
      ),
    ).rejects.toThrow("not available");
  });

  test("corrupt settings JSON fails loudly instead of silently dropping rules", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaps-settings-"));
    mkdirSync(join(cwd, ".minerva"));
    writeFileSync(join(cwd, ".minerva", "settings.json"), "{not json");
    await expect(
      loadSettings(defaultRuntime, mkdtempSync(join(tmpdir(), "gaps-data-")), cwd),
    ).rejects.toThrow("invalid JSON");
  });
});

describe("agent loop edges", () => {
  test("an unknown tool becomes an error result and the loop continues", async () => {
    const h = harness(
      createScriptedProvider([
        [{ type: "tool-call", toolCallId: "c1", toolName: "not_a_tool", input: {} }, FINISH_TOOLS],
        [{ type: "text-delta", text: "recovered" }, FINISH_STOP],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "call something fake" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const failed = h.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(JSON.stringify(failed)).toContain("Unknown tool");
  });

  test("a tool that throws mid-execution fails that call, not the turn", async () => {
    const h = harness(
      createScriptedProvider([
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "does-not-exist.txt" },
          },
          FINISH_TOOLS,
        ],
        [{ type: "text-delta", text: "noted" }, FINISH_STOP],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "read the missing file" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const failed = h.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
    );
    expect(failed).toBeDefined();
  });

  test("a provider error fails the prompt and logs turn.failed", async () => {
    const h = harness(
      createScriptedProvider([
        [{ type: "error", error: new Error("model exploded") } as TurnEvent],
      ]),
    );
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    await expect(
      h.client.request(AGENT_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "boom" }],
      }),
    ).rejects.toThrow("model exploded");

    const session = h.kernel.getSession(sessionId);
    if (!session) throw new Error("missing session");
    await session.flush();
    const events = readFileSync(session.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "model exploded" });
  });

  test("cancelling mid-turn synthesizes results for pending tool calls", async () => {
    let cancelNow: (() => void) | undefined;
    const slowProvider: ModelProvider = {
      id: "slow",
      async *streamTurn() {
        yield { type: "text-delta", text: "working" } as const;
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "echo never-runs" },
        } as const;
        // Signal the test to cancel, then let the cancellation land before
        // the stream finishes.
        cancelNow?.();
        await Bun.sleep(80);
        yield { type: "finish", finishReason: "tool-calls", usage: {} } as const;
      },
    };
    const h = harness(slowProvider);
    await h.client.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
    const { sessionId } = await h.client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
      cwd: h.cwd,
    });
    cancelNow = () => h.client.notify(AGENT_METHODS.sessionCancel, { sessionId });

    const result = await h.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text: "start something slow" }],
    });
    expect(result.stopReason).toBe("cancelled");

    // The assistant message with its tool call was recorded, and the batch
    // got synthesized cancelled results — no dangling tool_use.
    const session = h.kernel.getSession(sessionId);
    expect(session?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(session?.messages.at(-1))).toContain("cancelled");
  });
});

describe("replay edges", () => {
  test("orphan tool results and unknown events are tolerated", () => {
    const events = [
      { type: "user.message", text: "hi", at: "t" },
      // Result with no expected call (foreign log shape).
      { type: "tool.result", toolCallId: "ghost", output: "x", isError: false, at: "t" },
      // Unknown future event type must not crash replay.
      { type: "someday.new_event", at: "t" } as unknown,
      // A tool.call for a tool that no longer exists → title falls back.
      {
        type: "assistant.message",
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "gone_tool", input: {} }],
        at: "t",
      },
      { type: "tool.call", toolCallId: "c1", toolName: "gone_tool", input: {}, at: "t" },
      { type: "tool.result", toolCallId: "c1", output: "ok", isError: false, at: "t" },
    ] as SessionEvent[];

    const replay = replayEvents(events, []);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const toolStart = replay.updates.find((u) => u.sessionUpdate === "tool_call");
    expect(toolStart).toMatchObject({ title: "gone_tool" });
  });
});
