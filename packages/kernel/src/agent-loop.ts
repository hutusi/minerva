import {
  CLIENT_METHODS,
  type Connection,
  type RequestPermissionResult,
  type SessionUpdate,
  type StopReason,
} from "@minerva/protocol";
import type {
  ModelProvider,
  ProviderToolCall,
  ProviderToolResult,
  TurnFinishReason,
  TurnUsage,
} from "@minerva/providers";
import { now } from "./events";
import type { Runtime } from "./runtime";
import type { Session } from "./session";
import type { KernelTool } from "./tools";

/** Backstop against runaway loops; becomes configurable with modes in slice 2. */
const MAX_MODEL_TURNS = 40;

export interface LoopContext {
  session: Session;
  connection: Connection;
  provider: ModelProvider;
  tools: KernelTool[];
  system: string;
  runtime: Runtime;
}

export async function runPrompt(
  context: LoopContext,
  promptText: string,
): Promise<{ stopReason: StopReason }> {
  const { session, provider, tools, system } = context;
  const signal = session.beginPrompt();
  const toolDefinitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  try {
    session.append({ type: "user.message", text: promptText, at: now() });
    session.messages.push({ role: "user", content: promptText });

    for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
      let text = "";
      const toolCalls: ProviderToolCall[] = [];
      let finishReason: TurnFinishReason = "other";
      let usage: TurnUsage | undefined;
      let streamError: unknown;

      try {
        const stream = provider.streamTurn({
          system,
          messages: session.messages,
          tools: toolDefinitions,
          abortSignal: signal,
        });
        for await (const event of stream) {
          switch (event.type) {
            case "text-delta":
              text += event.text;
              sendUpdate(context, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.text },
              });
              break;
            case "tool-call":
              toolCalls.push(event);
              break;
            case "finish":
              finishReason = event.finishReason;
              usage = event.usage;
              break;
            case "error":
              streamError = event.error;
              break;
          }
        }
      } catch (error) {
        if (session.cancelled) return finish(session, "cancelled");
        throw error;
      }
      if (session.cancelled) return finish(session, "cancelled", usage);
      if (streamError !== undefined) {
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }

      if (text) session.append({ type: "assistant.message", text, at: now() });
      if (text || toolCalls.length > 0) {
        session.messages.push({ role: "assistant", text, toolCalls });
      }

      if (toolCalls.length === 0) {
        return finish(session, finishReason === "length" ? "max_tokens" : "end_turn", usage);
      }

      const results: ProviderToolResult[] = [];
      for (const call of toolCalls) {
        if (session.cancelled) return finish(session, "cancelled", usage);
        results.push(await executeToolCall(context, call, toolsByName.get(call.toolName)));
      }
      session.messages.push({ role: "tool", results });
    }
    return finish(session, "max_turn_requests");
  } finally {
    session.endPrompt();
    await session.flush();
  }
}

async function executeToolCall(
  context: LoopContext,
  call: ProviderToolCall,
  tool: KernelTool | undefined,
): Promise<ProviderToolResult> {
  const { session } = context;
  session.append({
    type: "tool.call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    at: now(),
  });
  const kind = tool?.kind ?? "other";
  sendUpdate(context, {
    sessionUpdate: "tool_call",
    toolCallId: call.toolCallId,
    title: titleFor(tool, call),
    kind,
    status: "pending",
    rawInput: call.input,
  });

  if (!tool) {
    return completeToolCall(context, call, {
      output: `Unknown tool: ${call.toolName}`,
      isError: true,
    });
  }

  const decision = await checkPermission(context, call, tool);
  session.append({
    type: "permission.decision",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    decision: decision.allowed ? "allowed" : "denied",
    source: decision.source,
    at: now(),
  });
  if (!decision.allowed) {
    return completeToolCall(context, call, {
      output: "The user denied permission for this tool call.",
      isError: true,
    });
  }

  sendUpdate(context, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.toolCallId,
    status: "in_progress",
  });

  let output: string;
  let isError: boolean;
  try {
    const result = await tool.execute(call.input, {
      cwd: session.cwd,
      runtime: context.runtime,
    });
    output = result.output;
    isError = result.isError ?? false;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    isError = true;
  }
  return completeToolCall(context, call, { output, isError });
}

function completeToolCall(
  context: LoopContext,
  call: ProviderToolCall,
  result: { output: string; isError: boolean },
): ProviderToolResult {
  context.session.append({
    type: "tool.result",
    toolCallId: call.toolCallId,
    output: result.output,
    isError: result.isError,
    at: now(),
  });
  sendUpdate(context, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.toolCallId,
    status: result.isError ? "failed" : "completed",
    content: [{ type: "content", content: { type: "text", text: result.output } }],
    rawOutput: result,
  });
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: result.output,
    isError: result.isError,
  };
}

interface PermissionDecision {
  allowed: boolean;
  source: "policy" | "user";
}

/**
 * Slice-1 policy: read-only tools are allowed outright; everything else asks
 * the frontend via ACP session/request_permission. The rule engine and
 * session modes (design decision #5) replace the first branch in slice 2.
 */
async function checkPermission(
  context: LoopContext,
  call: ProviderToolCall,
  tool: KernelTool,
): Promise<PermissionDecision> {
  if (tool.readOnly) return { allowed: true, source: "policy" };

  try {
    const result = await context.connection.request<RequestPermissionResult>(
      CLIENT_METHODS.sessionRequestPermission,
      {
        sessionId: context.session.id,
        toolCall: {
          toolCallId: call.toolCallId,
          title: titleFor(tool, call),
          kind: tool.kind,
          rawInput: call.input,
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    const allowed = result.outcome.outcome === "selected" && result.outcome.optionId === "allow";
    return { allowed, source: "user" };
  } catch {
    // A frontend that can't answer permission requests gets deny-by-default.
    return { allowed: false, source: "user" };
  }
}

function titleFor(tool: KernelTool | undefined, call: ProviderToolCall): string {
  if (!tool) return call.toolName;
  try {
    return tool.title(call.input);
  } catch {
    return tool.name;
  }
}

function sendUpdate(context: LoopContext, update: SessionUpdate): void {
  context.connection.notify(CLIENT_METHODS.sessionUpdate, {
    sessionId: context.session.id,
    update,
  });
}

function finish(
  session: Session,
  stopReason: StopReason,
  usage?: TurnUsage,
): { stopReason: StopReason } {
  session.append({ type: "turn.completed", stopReason, usage, at: now() });
  return { stopReason };
}
