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
  type SessionUpdateParams,
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
  permissionRequests: RequestPermissionParams[];
  sessionId: string;
  logEvents: () => SessionEvent[];
}

async function setup(options: {
  turns: TurnEvent[][];
  permission?: "allow" | "reject";
}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "minerva-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "minerva-data-"));
  writeFileSync(join(cwd, "hello.txt"), "hi from disk\n");

  const [clientTransport, kernelTransport] = createInProcTransportPair();
  const kernel = createKernel(kernelTransport, {
    provider: createScriptedProvider(options.turns),
    dataDir,
  });

  const client = new Connection(clientTransport);
  const updates: SessionUpdateParams[] = [];
  const permissionRequests: RequestPermissionParams[] = [];
  client.handleNotification(CLIENT_METHODS.sessionUpdate, (params) => {
    updates.push(params as SessionUpdateParams);
  });
  client.handleRequest(CLIENT_METHODS.sessionRequestPermission, (params) => {
    permissionRequests.push(params as RequestPermissionParams);
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
    permissionRequests,
    sessionId,
    logEvents: () => {
      const logPath = kernel.getSession(sessionId)?.logPath;
      if (!logPath) throw new Error("session log not found");
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SessionEvent);
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
    expect(prompt(harness, "second")).rejects.toThrow("already running");
    await first;
  });
});
