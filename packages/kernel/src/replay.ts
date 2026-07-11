import type { PlanEntry, SessionUpdate } from "@minerva/protocol";
import type {
  ProviderMessage,
  ProviderToolCall,
  ProviderToolResult,
  TurnUsage,
} from "@minerva/providers";
import { compactedContextMessage } from "./compact";
import type { SessionEvent } from "./events";
import type { KernelTool } from "./tools";
import { addUsage } from "./usage";

export interface ReplayResult {
  /** Provider messages, ready to continue the conversation. */
  messages: ProviderMessage[];
  /** Session updates that re-render the transcript in any frontend. */
  updates: SessionUpdate[];
  todos: PlanEntry[];
  /** Last mode recorded in the log, if any. */
  modeId?: string | undefined;
  /** Token spend summed over every completed turn in the log. */
  usage: TurnUsage;
}

/**
 * Rebuild session state from the event log — the other half of design
 * decision #7 (the event stream is the source of truth). A turn interrupted
 * by a crash may leave tool calls without results; those are synthesized as
 * errors so the resumed history is well-formed for the provider.
 */
export function replayEvents(events: SessionEvent[], tools: KernelTool[]): ReplayResult {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const messages: ProviderMessage[] = [];
  const updates: SessionUpdate[] = [];
  let todos: PlanEntry[] = [];
  let modeId: string | undefined;
  let usage: TurnUsage = {};

  let expected: ProviderToolCall[] = [];
  let results: ProviderToolResult[] = [];

  // Close out an assistant turn: synthesize error results for tool calls the
  // log never resolved, then emit the role:"tool" message.
  const flushToolBatch = () => {
    if (expected.length === 0) return;
    for (const call of expected) {
      if (results.some((result) => result.toolCallId === call.toolCallId)) continue;
      results.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: "Tool call was interrupted before completing (session resumed).",
        isError: true,
      });
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: call.toolCallId,
        status: "failed",
      });
    }
    messages.push({ role: "tool", results });
    expected = [];
    results = [];
  };

  for (const event of events) {
    switch (event.type) {
      case "user.message":
        flushToolBatch();
        messages.push({ role: "user", content: event.text });
        updates.push({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: event.text },
        });
        break;

      case "assistant.thought":
        // Display-only: re-render the thought, never rebuild it into
        // provider messages. Log order matches stream order, so replay
        // re-renders thoughts exactly where the user watched them.
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.text },
        });
        break;

      case "assistant.message": {
        flushToolBatch();
        const toolCalls = event.toolCalls ?? [];
        messages.push({ role: "assistant", text: event.text, toolCalls });
        if (event.text) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.text },
          });
        }
        expected = [...toolCalls];
        break;
      }

      case "tool.call": {
        const tool = toolsByName.get(event.toolName);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: titleFor(tool, event.toolName, event.input),
          kind: tool?.kind ?? "other",
          status: "pending",
          rawInput: event.input,
        });
        break;
      }

      case "tool.result": {
        const call = expected.find((entry) => entry.toolCallId === event.toolCallId);
        // A result with no expected call (foreign/damaged log) still renders
        // in the UI but can't be attached to a provider message.
        if (call) {
          results.push({
            toolCallId: event.toolCallId,
            toolName: call.toolName,
            output: event.output,
            isError: event.isError,
          });
        }
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: event.output } }],
        });
        if (expected.length > 0 && results.length === expected.length) {
          messages.push({ role: "tool", results });
          expected = [];
          results = [];
        }
        break;
      }

      case "todo.updated":
        todos = event.entries;
        updates.push({ sessionUpdate: "plan", entries: event.entries });
        break;

      case "session.mode_changed":
        modeId = event.modeId;
        break;

      case "session.compacted":
        // The model context restarts from the summary; the UI transcript
        // (already emitted above) keeps the full history. Restore the
        // summarization turn's spend so the session total survives resume.
        usage = addUsage(usage, event.usage);
        flushToolBatch();
        messages.length = 0;
        messages.push(compactedContextMessage(event.summary));
        break;

      case "turn.completed":
        // Spend telemetry survives compaction: session.compacted resets the
        // model context above, but not what the session has already cost.
        usage = addUsage(usage, event.usage);
        flushToolBatch();
        break;

      case "turn.failed":
        flushToolBatch();
        // Mirror the live loop (agent-loop dropUnansweredUser): a turn that
        // failed with no assistant output leaves the user prompt trailing;
        // drop it from provider context so a retry after resume doesn't send
        // two consecutive user messages. The UI transcript keeps the prompt.
        if (messages.at(-1)?.role === "user") messages.pop();
        break;

      default:
        break;
    }
  }
  flushToolBatch();

  if (modeId) updates.push({ sessionUpdate: "current_mode_update", currentModeId: modeId });
  return { messages, updates, todos, modeId, usage };
}

function titleFor(tool: KernelTool | undefined, toolName: string, input: unknown): string {
  if (!tool) return toolName;
  try {
    return tool.title(input);
  } catch {
    return tool.name;
  }
}
