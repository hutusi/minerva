import {
  CLIENT_METHODS,
  type Connection,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUsageParams,
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
import { escapeRuleValue, formatRule, permissionValue } from "./permissions";
import type { Runtime } from "./runtime";
import type { Session } from "./session";
import { persistAllowRule } from "./settings";
import type { KernelTool } from "./tools";
import { addUsage, hasUsage, toTokenUsage } from "./usage";

/** Backstop against runaway loops; becomes configurable with modes in slice 2. */
const MAX_MODEL_TURNS = 40;

export interface LoopContext {
  session: Session;
  connection: Connection;
  provider: ModelProvider;
  tools: KernelTool[];
  system: string;
  runtime: Runtime;
  signal?: AbortSignal | undefined;
}

export async function runPrompt(
  context: LoopContext,
  promptText: string,
): Promise<{ stopReason: StopReason }> {
  const { session } = context;
  const signal = session.beginPrompt();
  try {
    return await runLoop({ ...context, signal }, promptText);
  } catch (error) {
    // Errored turns must still leave a terminal event, or replay/audit can't
    // tell a crashed turn from one still in flight.
    session.append({
      type: "turn.failed",
      error: error instanceof Error ? error.message : String(error),
      at: now(),
    });
    throw error;
  } finally {
    session.endPrompt();
    await session.flush();
  }
}

async function runLoop(
  context: LoopContext,
  promptText: string,
): Promise<{ stopReason: StopReason }> {
  const { session, provider, tools, system, signal } = context;
  const toolDefinitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  session.append({ type: "user.message", text: promptText, at: now() });
  session.messages.push({ role: "user", content: promptText });

  // Accumulated across every model turn of this prompt: each tool-call
  // round-trip reports its own usage, and turn.completed must record the
  // whole prompt's spend, not just the final model turn's.
  let promptUsage: TurnUsage | undefined;

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
    let text = "";
    const toolCalls: ProviderToolCall[] = [];
    let finishReason: TurnFinishReason = "other";
    let streamError: unknown;

    // Everything streamed to the UI must also be recorded, even when the
    // turn is cancelled mid-stream — the event log has to be able to
    // re-render what the user actually saw.
    const recordAssistantMessage = () => {
      if (text || toolCalls.length > 0) {
        // toolCalls ride on the event so replay can rebuild the provider
        // message even for turns where the model emitted no text.
        session.append({ type: "assistant.message", text, toolCalls, at: now() });
        session.messages.push({ role: "assistant", text, toolCalls });
      }
    };
    // A pushed assistant message with tool calls must always be followed by
    // matching tool results, or the provider rejects the whole history on
    // the next prompt.
    const cancelToolBatch = () => {
      if (toolCalls.length === 0) return;
      session.messages.push({
        role: "tool",
        results: toolCalls.map((call) => cancelToolCall(context, call)),
      });
    };

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
            promptUsage = addUsage(promptUsage ?? {}, event.usage);
            break;
          case "error":
            streamError = event.error;
            break;
        }
      }
    } catch (error) {
      if (!session.cancelled) throw error;
    }
    if (session.cancelled) {
      recordAssistantMessage();
      cancelToolBatch();
      return finish(context, "cancelled", promptUsage);
    }
    if (streamError !== undefined) {
      throw streamError instanceof Error ? streamError : new Error(String(streamError));
    }

    recordAssistantMessage();

    if (toolCalls.length === 0) {
      return finish(context, finishReason === "length" ? "max_tokens" : "end_turn", promptUsage);
    }

    const results: ProviderToolResult[] = [];
    for (const call of toolCalls) {
      results.push(
        session.cancelled
          ? cancelToolCall(context, call)
          : await executeToolCall(context, call, toolsByName.get(call.toolName)),
      );
    }
    session.messages.push({ role: "tool", results });
    if (session.cancelled) return finish(context, "cancelled", promptUsage);
  }
  return finish(context, "max_turn_requests", promptUsage);
}

async function executeToolCall(
  context: LoopContext,
  call: ProviderToolCall,
  tool: KernelTool | undefined,
): Promise<ProviderToolResult> {
  const { session } = context;
  startToolCall(context, call, tool);

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
    rule: decision.rule,
    at: now(),
  });
  if (!decision.allowed) {
    return completeToolCall(context, call, {
      output: decision.reason ?? deniedMessage(decision.source),
      isError: true,
    });
  }
  // The permission round-trip can take arbitrarily long; a cancel that
  // arrived while the prompt was showing must win over a late approval.
  if (session.cancelled) {
    return completeToolCall(context, call, {
      output: "Tool call cancelled by user.",
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
      signal: context.signal,
      updateTodos: (entries) => {
        session.todos = entries;
        session.append({ type: "todo.updated", entries, at: now() });
        sendUpdate(context, { sessionUpdate: "plan", entries });
      },
    });
    output = result.output;
    isError = result.isError ?? false;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    isError = true;
  }
  return completeToolCall(context, call, { output, isError });
}

/** Resolve a tool call as cancelled without executing it. */
function cancelToolCall(context: LoopContext, call: ProviderToolCall): ProviderToolResult {
  startToolCall(
    context,
    call,
    context.tools.find((tool) => tool.name === call.toolName),
  );
  return completeToolCall(context, call, {
    output: "Tool call cancelled by user.",
    isError: true,
  });
}

function startToolCall(
  context: LoopContext,
  call: ProviderToolCall,
  tool: KernelTool | undefined,
): void {
  context.session.append({
    type: "tool.call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    at: now(),
  });
  sendUpdate(context, {
    sessionUpdate: "tool_call",
    toolCallId: call.toolCallId,
    title: titleFor(tool, call),
    kind: tool?.kind ?? "other",
    status: "pending",
    rawInput: call.input,
  });
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
  /** Who actually decided — the audit log must not blame the user for
   * transport failures or frontend defaults. */
  source: "policy" | "user" | "frontend" | "error";
  /** The permission rule that decided or was created, when there is one. */
  rule?: string | undefined;
  /** Denial text for the model, when the default message won't do. */
  reason?: string | undefined;
}

function deniedMessage(source: PermissionDecision["source"]): string {
  return source === "user"
    ? "The user denied permission for this tool call."
    : "Permission could not be granted for this tool call.";
}

/**
 * Rule engine + session modes (design decision #5): the engine decides
 * allow/deny/ask; only "ask" round-trips to the frontend via ACP
 * session/request_permission. An allow_always answer becomes a persisted
 * project rule.
 */
async function checkPermission(
  context: LoopContext,
  call: ProviderToolCall,
  tool: KernelTool,
): Promise<PermissionDecision> {
  const { session } = context;
  const verdict = session.permissions.evaluate(tool, call.input, session.mode);
  if (verdict.action === "allow") {
    return { allowed: true, source: "policy", rule: verdict.rule };
  }
  if (verdict.action === "deny") {
    return { allowed: false, source: "policy", rule: verdict.rule, reason: verdict.reason };
  }

  try {
    const result = await context.connection.request<RequestPermissionResult>(
      CLIENT_METHODS.sessionRequestPermission,
      {
        sessionId: session.id,
        toolCall: {
          toolCallId: call.toolCallId,
          title: titleFor(tool, call),
          kind: tool.kind,
          rawInput: call.input,
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
      context.signal,
    );
    if (result.outcome.outcome === "cancelled") {
      // ACP: the frontend is cancelling the turn, not answering the question.
      session.cancel();
      return { allowed: false, source: "frontend" };
    }
    if (result.outcome.optionId === "allow_always") {
      // Escape wildcards: the user approved this exact call, not a pattern.
      const rule = formatRule(tool.name, escapeRuleValue(permissionValue(call.input)));
      session.permissions.addAllowRule(rule);
      try {
        await persistAllowRule(context.runtime, session.cwd, rule);
      } catch {
        // The in-memory rule still covers this session; persistence failure
        // must not fail an approved tool call.
      }
      return { allowed: true, source: "user", rule };
    }
    return { allowed: result.outcome.optionId === "allow", source: "user" };
  } catch {
    // Transport failure or aborted prompt: deny by default, and don't
    // attribute the denial to a user who was never asked.
    return { allowed: false, source: "error" };
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
  context: LoopContext,
  stopReason: StopReason,
  usage?: TurnUsage,
): { stopReason: StopReason } {
  const { session } = context;
  session.append({ type: "turn.completed", stopReason, usage, at: now() });
  // Providers that report nothing (scripted fixtures, some proxies) get no
  // notification rather than a misleading all-zero one.
  if (hasUsage(usage)) {
    session.addTurnUsage(usage);
    const params: SessionUsageParams = {
      sessionId: session.id,
      lastTurn: toTokenUsage(usage),
      cumulative: toTokenUsage(session.usage),
    };
    context.connection.notify(CLIENT_METHODS.sessionUsage, params);
  }
  return { stopReason };
}
