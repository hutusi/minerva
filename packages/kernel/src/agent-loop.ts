import {
  CLIENT_METHODS,
  type Connection,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUsageParams,
  type StopReason,
  type ToolCallContent,
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
import { contextSize } from "./replay";
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
  /**
   * From the session's prompt lease, claimed by the CALLER synchronously
   * after its promptActive guard (an await between guard and claim opens a
   * same-tick race). runPrompt releases the lease when it settles.
   */
  signal: AbortSignal;
}

export async function runPrompt(
  context: LoopContext,
  promptText: string,
  /** Model-facing text when it differs from promptText (skill expansion). */
  providerText?: string,
): Promise<{ stopReason: StopReason }> {
  const { session } = context;
  try {
    return await runLoop(context, promptText, providerText);
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
  providerText?: string,
): Promise<{ stopReason: StopReason }> {
  const { session, provider, tools, system, signal } = context;
  const toolDefinitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  session.append({
    type: "user.message",
    text: promptText,
    ...(providerText !== undefined ? { providerText } : {}),
    at: now(),
  });
  session.messages.push({ role: "user", content: providerText ?? promptText });

  // Accumulated across every model turn of this prompt: each tool-call
  // round-trip reports its own usage, and turn.completed must record the
  // whole prompt's spend, not just the final model turn's.
  let promptUsage: TurnUsage | undefined;

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
    let text = "";
    let thought = "";
    // Set once any reasoning streamed this turn, even segments already
    // flushed: a thought-only turn still needs an assistant message pushed,
    // or the next prompt sends two consecutive user messages and strict
    // role-alternating endpoints reject the whole history.
    let hadThought = false;
    // A new reasoning block started while the current thought is non-empty:
    // insert a blank line before its first delta so back-to-back blocks read
    // as distinct paragraphs instead of one run-on thought. Deferred to the
    // next delta so an empty trailing block adds no whitespace.
    let pendingThoughtSeparator = false;
    const toolCalls: ProviderToolCall[] = [];
    let finishReason: TurnFinishReason = "other";
    let streamError: unknown;

    // Thoughts are display-only: persisted so replay re-renders what the
    // user saw, but never pushed into provider messages (openai-compatible
    // endpoints don't want reasoning echoed back).
    const flushThought = () => {
      if (!thought) return;
      session.append({ type: "assistant.thought", text: thought, at: now() });
      thought = "";
    };

    // Everything streamed to the UI must also be recorded, even when the
    // turn is cancelled mid-stream — the event log has to be able to
    // re-render what the user actually saw.
    const recordAssistantMessage = () => {
      if (text || toolCalls.length > 0 || hadThought) {
        // toolCalls ride on the event so replay can rebuild the provider
        // message even for turns where the model emitted no text. A
        // thought-only turn records an empty message (serialized as
        // content: "" on OpenAI-compatible wires) to keep role alternation.
        session.append({ type: "assistant.message", text, toolCalls, at: now() });
        session.messages.push({ role: "assistant", text, toolCalls });
      }
    };
    // A pushed assistant message with tool calls must always be followed by
    // matching tool results, or the provider rejects the whole history on
    // the next prompt — whether the calls died to cancellation or an error.
    const resolveToolBatch = (output: string) => {
      if (toolCalls.length === 0) return;
      session.messages.push({
        role: "tool",
        results: toolCalls.map((call) => resolveToolCall(context, call, output)),
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
            // Empty deltas (DashScope keep-alives) must not end a thought
            // segment or open a phantom item in the client view.
            if (!event.text) break;
            // A text or tool event ends the thought segment, keeping log
            // order faithful for thought→text→thought turns.
            flushThought();
            text += event.text;
            sendUpdate(context, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            });
            break;
          case "reasoning-start":
            // Only a boundary between two non-empty blocks needs a separator.
            pendingThoughtSeparator = thought.length > 0;
            break;
          case "reasoning-delta": {
            if (!event.text) break;
            hadThought = true;
            // Guard on thought.length too: a text/tool event between the
            // block boundary and here already flushed the thought, so the
            // new block starts a fresh item that needs no separator.
            const chunk =
              pendingThoughtSeparator && thought.length > 0 ? `\n\n${event.text}` : event.text;
            pendingThoughtSeparator = false;
            thought += chunk;
            // Stream the same text that is persisted, so the client's live
            // thought and the replayed one are byte-identical.
            sendUpdate(context, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: chunk },
            });
            break;
          }
          case "tool-call":
            flushThought();
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
      // A non-cancel throw is handled like a streamed error event below, so
      // partial output still lands in the log before the prompt fails. An
      // earlier error event wins: it is what actually ended the stream.
      if (!session.cancelled) streamError ??= error;
    }
    // Covers every exit — cancellation, stream errors, thought-only turns:
    // everything streamed to the UI must land in the log (it re-renders what
    // the user saw), and in stream order: any still-buffered thought
    // postdates the accumulated text, since earlier thought segments were
    // flushed at the first following text or tool event.
    recordAssistantMessage();
    flushThought();
    // A turn that ends (cancel or error) having recorded no assistant message
    // leaves the user prompt as the trailing provider message; drop it so a
    // retry doesn't send two consecutive user messages that strict endpoints
    // reject. Only fires when no assistant/tool followed the user this turn.
    const dropUnansweredUser = () => {
      if (session.messages.at(-1)?.role === "user") session.messages.pop();
    };
    if (session.cancelled) {
      dropUnansweredUser();
      resolveToolBatch("Tool call cancelled by user.");
      return finish(context, "cancelled", promptUsage);
    }
    if (streamError !== undefined) {
      // The recorded assistant message may carry tool calls that will never
      // execute; resolve them so the history has no dangling tool use.
      dropUnansweredUser();
      resolveToolBatch("Tool call was interrupted by a model stream error.");
      throw streamError instanceof Error ? streamError : new Error(String(streamError));
    }

    if (toolCalls.length === 0) {
      return finish(context, finishReason === "length" ? "max_tokens" : "end_turn", promptUsage);
    }

    const results: ProviderToolResult[] = [];
    for (const call of toolCalls) {
      results.push(
        session.cancelled
          ? resolveToolCall(context, call, "Tool call cancelled by user.")
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
    return completeToolCall(context, call, {
      output: result.output,
      isError: result.isError ?? false,
      ...(result.content ? { content: result.content } : {}),
    });
  } catch (error) {
    return completeToolCall(context, call, {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    });
  }
}

/** Resolve a tool call with a synthesized error result, without executing it. */
function resolveToolCall(
  context: LoopContext,
  call: ProviderToolCall,
  output: string,
): ProviderToolResult {
  startToolCall(
    context,
    call,
    context.tools.find((tool) => tool.name === call.toolName),
  );
  return completeToolCall(context, call, { output, isError: true });
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
  result: { output: string; isError: boolean; content?: ToolCallContent[] },
): ProviderToolResult {
  context.session.append({
    type: "tool.result",
    toolCallId: call.toolCallId,
    output: result.output,
    isError: result.isError,
    ...(result.content ? { content: result.content } : {}),
    at: now(),
  });
  sendUpdate(context, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.toolCallId,
    status: result.isError ? "failed" : "completed",
    content: [
      ...(result.content ?? []),
      { type: "content", content: { type: "text", text: result.output } },
    ],
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
    // The auto-compaction signal: what this prompt's turns occupied of the
    // context window (kept separate from cumulative spend on purpose).
    session.lastTurnContext = contextSize(usage) ?? session.lastTurnContext;
    const params: SessionUsageParams = {
      sessionId: session.id,
      lastTurn: toTokenUsage(usage),
      cumulative: toTokenUsage(session.usage),
    };
    context.connection.notify(CLIENT_METHODS.sessionUsage, params);
  }
  return { stopReason };
}
