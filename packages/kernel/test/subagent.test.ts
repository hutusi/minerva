import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  Connection,
  createInProcTransportPair,
  MINERVA_METHODS,
  PROTOCOL_VERSION,
  type RequestPermissionParams,
  type SessionsListResult,
  type SessionTaskUpdateParams,
  type SessionUpdateParams,
  type SessionUsageParams,
} from "@minerva/protocol";
import { createScriptedProvider, type ModelProvider, type TurnEvent } from "@minerva/providers";
import {
  createKernel,
  type MinervaKernel,
  projectDir,
  replayEvents,
  type SessionEvent,
} from "../src";
import { taskTool } from "../src/tools";

const kernels: MinervaKernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});

const TASK_CALL: TurnEvent = {
  type: "tool-call",
  toolCallId: "t1",
  toolName: "task",
  input: { description: "survey tests", prompt: "Count the tests and report." },
};
const FINISH_TOOLS: TurnEvent = {
  type: "finish",
  finishReason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 5 },
};
const CHILD_FINISH: TurnEvent = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 40 },
};
const PARENT_FINISH: TurnEvent = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 20, outputTokens: 8 },
};

interface Harness {
  client: Connection;
  updates: SessionUpdateParams[];
  taskUpdates: SessionTaskUpdateParams[];
  usageNotices: SessionUsageParams[];
  permissionRequests: RequestPermissionParams[];
  sessionId: string;
  cwd: string;
  dataDir: string;
  parentEvents: () => SessionEvent[];
  childEvents: (childSessionId: string) => SessionEvent[];
}

async function setup(options: {
  turns?: TurnEvent[][];
  provider?: ModelProvider;
  permission?: "allow" | "allow_always" | "reject";
  onTaskUpdate?: (harness: Harness, params: SessionTaskUpdateParams) => void;
}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-sub-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-sub-data-"));
  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    provider: options.provider ?? createScriptedProvider(options.turns ?? []),
    dataDir,
  });
  kernels.push(kernel);

  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  const taskUpdates: SessionTaskUpdateParams[] = [];
  const usageNotices: SessionUsageParams[] = [];
  const permissionRequests: RequestPermissionParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  client.handleNotification(CLIENT_METHODS.sessionUsage, (params) => {
    usageNotices.push(params as SessionUsageParams);
  });
  client.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) => {
    permissionRequests.push(params as RequestPermissionParams);
    return { outcome: { outcome: "selected", optionId: options.permission ?? "allow" } };
  });

  await client.request(AGENT_METHODS.initialize, { protocolVersion: PROTOCOL_VERSION });
  const { sessionId } = await client.request<{ sessionId: string }>(AGENT_METHODS.sessionNew, {
    cwd,
  });

  const readEvents = (id: string): SessionEvent[] =>
    readFileSync(join(projectDir(dataDir, cwd), `${id}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent);
  const harness: Harness = {
    client,
    updates,
    taskUpdates,
    usageNotices,
    permissionRequests,
    sessionId,
    cwd,
    dataDir,
    parentEvents: () => readEvents(sessionId),
    childEvents: (childSessionId) => readEvents(childSessionId),
  };
  client.handleNotification(CLIENT_METHODS.sessionTaskUpdate, (params) => {
    const taskParams = params as SessionTaskUpdateParams;
    taskUpdates.push(taskParams);
    options.onTaskUpdate?.(harness, taskParams);
  });
  return harness;
}

function prompt(harness: Harness, text: string) {
  return harness.client.request<{ stopReason: string }>(AGENT_METHODS.sessionPrompt, {
    sessionId: harness.sessionId,
    prompt: [{ type: "text", text }],
  });
}

describe("subagents", () => {
  test("happy path: child report becomes the tool result; logs, usage, and list stay honest", async () => {
    const harness = await setup({
      turns: [
        [TASK_CALL, FINISH_TOOLS],
        [{ type: "text-delta", text: "Report: 42 tests." }, CHILD_FINISH],
        [{ type: "text-delta", text: "Done." }, PARENT_FINISH],
      ],
    });

    const result = await prompt(harness, "survey the tests");
    expect(result.stopReason).toBe("end_turn");

    // The parent transcript shows an ordinary tool call carrying the report.
    const toolStart = harness.updates.find((u) => u.update.sessionUpdate === "tool_call");
    expect(toolStart?.update).toMatchObject({ title: "task: survey tests", kind: "other" });
    const completed = harness.updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
    );
    const rawOutput = (completed?.update as { rawOutput?: { output?: string } } | undefined)
      ?.rawOutput;
    expect(rawOutput?.output).toBe("Report: 42 tests.");

    // The child's live stream arrived re-scoped to the parent's task call.
    expect(harness.taskUpdates.length).toBeGreaterThan(0);
    for (const nested of harness.taskUpdates) {
      expect(nested.sessionId).toBe(harness.sessionId);
      expect(nested.toolCallId).toBe("t1");
    }
    expect(
      harness.taskUpdates.some(
        (nested) =>
          nested.update.sessionUpdate === "agent_message_chunk" &&
          nested.update.content.text === "Report: 42 tests.",
      ),
    ).toBe(true);
    const childSessionId = harness.taskUpdates[0]?.childSessionId as string;

    // Child log: a real session with recorded parentage and its own turn.
    const childEvents = harness.childEvents(childSessionId);
    expect(childEvents.find((e) => e.type === "session.created")).toMatchObject({
      sessionId: childSessionId,
      parent: harness.sessionId,
    });
    expect(childEvents.find((e) => e.type === "turn.completed")).toMatchObject({
      stopReason: "end_turn",
    });

    // Parent log: task.completed carries the child's spend for resume.
    expect(harness.parentEvents().find((e) => e.type === "task.completed")).toMatchObject({
      toolCallId: "t1",
      childSessionId,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    // Live roll-up first (cumulative only), then the parent's own turn.
    expect(harness.usageNotices).toEqual([
      { sessionId: harness.sessionId, cumulative: { inputTokens: 100, outputTokens: 40 } },
      {
        sessionId: harness.sessionId,
        lastTurn: { inputTokens: 30, outputTokens: 13 },
        cumulative: { inputTokens: 130, outputTokens: 53 },
      },
    ]);

    // Child sessions are audit artifacts, not picker entries.
    const list = await harness.client.request<SessionsListResult>(MINERVA_METHODS.sessionsList, {
      cwd: harness.cwd,
    });
    expect(list.sessions.map((s) => s.sessionId)).toEqual([harness.sessionId]);

    // Resume: replay restores the rolled-up total (task.completed + turn.completed).
    harness.usageNotices.length = 0;
    await harness.client.request(AGENT_METHODS.sessionLoad, {
      sessionId: harness.sessionId,
      cwd: harness.cwd,
    });
    expect(harness.usageNotices).toEqual([
      { sessionId: harness.sessionId, cumulative: { inputTokens: 130, outputTokens: 53 } },
    ]);
  }, 15_000);

  test("child permissions are judged by the parent: prompts attribute the task, plan mode blocks writes", async () => {
    const harness = await setup({
      permission: "allow_always",
      turns: [
        [TASK_CALL, FINISH_TOOLS],
        [
          {
            type: "tool-call",
            toolCallId: "w1",
            toolName: "write_file",
            input: { path: "note.txt", content: "from child" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [{ type: "text-delta", text: "wrote it" }, CHILD_FINISH],
        [{ type: "text-delta", text: "Done." }, PARENT_FINISH],
      ],
    });

    const result = await prompt(harness, "have a subagent write a note");
    expect(result.stopReason).toBe("end_turn");

    // The child's write prompted under the PARENT session, attributed to t1.
    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: harness.sessionId,
      taskToolCallId: "t1",
      toolCall: { toolCallId: "w1" },
    });
    expect(existsSync(join(harness.cwd, "note.txt"))).toBe(true);

    // allow_always persisted a rule into the shared (parent-owned) policy.
    const settings = JSON.parse(
      readFileSync(join(harness.cwd, ".minerva", "settings.json"), "utf8"),
    ) as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow?.some((rule) => rule.startsWith("write_file("))).toBe(true);
  }, 15_000);

  test("plan mode on the parent denies a child's write by policy", async () => {
    const harness = await setup({
      turns: [
        [TASK_CALL, FINISH_TOOLS],
        [
          {
            type: "tool-call",
            toolCallId: "w1",
            toolName: "write_file",
            input: { path: "note.txt", content: "from child" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [{ type: "text-delta", text: "blocked, reporting back" }, CHILD_FINISH],
        [{ type: "text-delta", text: "Done." }, PARENT_FINISH],
      ],
    });
    await harness.client.request(AGENT_METHODS.sessionSetMode, {
      sessionId: harness.sessionId,
      modeId: "plan",
    });

    const result = await prompt(harness, "try to write from a subagent");
    expect(result.stopReason).toBe("end_turn");

    // Denied by policy — no prompt reached the frontend, no file appeared.
    expect(harness.permissionRequests).toHaveLength(0);
    expect(existsSync(join(harness.cwd, "note.txt"))).toBe(false);
    const childSessionId = harness.taskUpdates[0]?.childSessionId as string;
    expect(
      harness.childEvents(childSessionId).find((e) => e.type === "permission.decision"),
    ).toMatchObject({ toolCallId: "w1", decision: "denied", source: "policy" });
  }, 15_000);

  test("a child cannot spawn: its toolset lacks task, and the tool fails without a runner", async () => {
    const harness = await setup({
      turns: [
        [TASK_CALL, FINISH_TOOLS],
        [
          {
            type: "tool-call",
            toolCallId: "n1",
            toolName: "task",
            input: { description: "nested", prompt: "go deeper" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ],
        [{ type: "text-delta", text: "cannot nest" }, CHILD_FINISH],
        [{ type: "text-delta", text: "Done." }, PARENT_FINISH],
      ],
    });

    const result = await prompt(harness, "nest a task");
    expect(result.stopReason).toBe("end_turn");
    const childSessionId = harness.taskUpdates[0]?.childSessionId as string;
    expect(harness.childEvents(childSessionId).find((e) => e.type === "tool.result")).toMatchObject(
      { toolCallId: "n1", isError: true, output: "Unknown tool: task" },
    );

    // Direct call without an injected runner (e.g. from a host without a
    // prompt loop) degrades to an error result, never a crash.
    const bare = await taskTool.execute(
      { description: "x", prompt: "y" },
      { cwd: harness.cwd, runtime: (await import("../src")).defaultRuntime },
    );
    expect(bare.isError).toBe(true);
    expect(bare.output).toContain("not available");
  }, 15_000);

  test("cancelling the parent turn aborts the child and records both terminals", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "blocking",
      async *streamTurn(request) {
        calls++;
        if (calls === 1) {
          yield TASK_CALL;
          yield FINISH_TOOLS;
          return;
        }
        // Child turn: stream a chunk, then hold until the abort arrives.
        yield { type: "text-delta", text: "child working" };
        await new Promise<void>((resolve) => {
          if (request.abortSignal?.aborted) return resolve();
          request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const harness = await setup({
      provider,
      onTaskUpdate: (h, params) => {
        if (params.update.sessionUpdate === "agent_message_chunk") {
          // Cancel the PARENT turn the moment the child shows life.
          h.client.notify(AGENT_METHODS.sessionCancel, { sessionId: h.sessionId });
        }
      },
    });

    const result = await prompt(harness, "start a task, then cancel");
    expect(result.stopReason).toBe("cancelled");

    const taskCompleted = harness.parentEvents().find((e) => e.type === "task.completed");
    expect(taskCompleted).toMatchObject({ toolCallId: "t1", stopReason: "cancelled" });
    const childSessionId = harness.taskUpdates[0]?.childSessionId as string;
    expect(
      harness.childEvents(childSessionId).find((e) => e.type === "turn.completed"),
    ).toMatchObject({ stopReason: "cancelled" });
    // The model-facing result says so too.
    expect(harness.parentEvents().find((e) => e.type === "tool.result")).toMatchObject({
      toolCallId: "t1",
      isError: true,
      output: "Subagent cancelled.",
    });
  }, 15_000);

  test("kill-9 mid-task: replaying a dangling task tool.call synthesizes the interrupted result", () => {
    const events: SessionEvent[] = [
      { type: "user.message", text: "go", at: "t" },
      {
        type: "assistant.message",
        text: "",
        toolCalls: [
          { toolCallId: "t1", toolName: "task", input: { description: "d", prompt: "p" } },
        ],
        at: "t",
      },
      { type: "tool.call", toolCallId: "t1", toolName: "task", input: {}, at: "t" },
      // ...process killed here: no tool.result, no task.completed.
    ];
    const replay = replayEvents(events, [taskTool]);
    const toolMessage = replay.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      results: [{ toolCallId: "t1", isError: true }],
    });
    expect(
      replay.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed"),
    ).toBe(true);
  });
});
