import { CLIENT_METHODS, type SessionUsageParams, type StopReason } from "@minerva/protocol";
import { type LoopContext, runPrompt } from "./agent-loop";
import { now } from "./events";
import { Session } from "./session";
import type { ToolOutput } from "./tools";
import { hasUsage, toTokenUsage } from "./usage";

/**
 * Subagents (design decision #15): a task tool call spawns a child agent
 * loop over a REAL persisted session — own JSONL log in the same project
 * dir, `parent` recorded — so every child side effect stays auditable and
 * the parent log needs nothing new for the kill-9 invariant (a dangling
 * task tool.call already gets the synthesized interrupted result on
 * resume). The child reuses runPrompt verbatim; everything child-specific
 * rides three optional LoopContext fields (policySession, task, and the
 * absence of spawnSubagent).
 */

export interface TaskInput {
  description: string;
  prompt: string;
}

/** Withheld from children: `task` (no recursive spawning in v1) and
 * `todo_write` (child todos would clobber the parent's plan in every UI). */
const EXCLUDED_CHILD_TOOLS = new Set(["task", "todo_write"]);

export async function runSubagent(
  parent: LoopContext,
  toolCallId: string,
  input: TaskInput,
): Promise<ToolOutput> {
  const policy = parent.policySession ?? parent.session;
  const child = await Session.create({
    cwd: parent.session.cwd,
    dataDir: parent.dataDir,
    providerId: parent.provider.id,
    runtime: parent.runtime,
    parent: parent.session.id,
    // Audit fidelity: the child runs under the parent's system prompt and
    // policy, so its log records the parent's actual persona and live mode —
    // never a settings default it didn't run with.
    inherited: { profile: parent.session.profile?.name, mode: policy.mode },
  });
  // The child claims its OWN lease — the parent's stays untouched. Esc /
  // session/cancel aborts the parent's signal, which chains here.
  const childSignal = child.beginPrompt();
  const cancelChild = () => child.cancel();
  parent.signal.addEventListener("abort", cancelChild, { once: true });
  if (parent.signal.aborted) child.cancel();

  const childContext: LoopContext = {
    session: child,
    connection: parent.connection,
    provider: parent.provider,
    tools: parent.tools.filter((tool) => !EXCLUDED_CHILD_TOOLS.has(tool.name)),
    // Same persona on the same repo: base prompt + AGENTS.md carry over.
    system: parent.system,
    runtime: parent.runtime,
    dataDir: parent.dataDir,
    signal: childSignal,
    policySession: policy,
    task: { parentSessionId: parent.session.id, toolCallId },
  };

  let stopReason: StopReason | "error" = "error";
  let failure: string | undefined;
  try {
    // A child stream error must become a parent TOOL error result, never a
    // parent turn.failed — the child's own log already recorded its failure.
    ({ stopReason } = await runPrompt(childContext, input.prompt));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    parent.signal.removeEventListener("abort", cancelChild);
    // Roll the child's spend into the parent on every exit path: live totals
    // via the usage notification, resumed totals via task.completed (replay
    // adds its usage back — the parent log never reads the child's turns).
    const childUsage = child.usage;
    const spent = hasUsage(childUsage);
    if (spent) {
      parent.session.addTurnUsage(childUsage);
      const params: SessionUsageParams = {
        sessionId: parent.session.id,
        cumulative: toTokenUsage(parent.session.usage),
      };
      parent.connection.notify(CLIENT_METHODS.sessionUsage, params);
    }
    parent.session.append({
      type: "task.completed",
      toolCallId,
      childSessionId: child.id,
      stopReason,
      ...(spent ? { usage: childUsage } : {}),
      at: now(),
    });
  }

  if (failure !== undefined) {
    return { output: `subagent failed: ${failure}`, isError: true };
  }
  if (stopReason === "cancelled") {
    return { output: "Subagent cancelled.", isError: true };
  }
  // The child's report is its last assistant text — the tool result is all
  // that enters the parent's model context.
  let report: string | undefined;
  for (let i = child.messages.length - 1; i >= 0; i--) {
    const message = child.messages[i];
    if (message?.role === "assistant" && message.text) {
      report = message.text;
      break;
    }
  }
  if (report === undefined) {
    return { output: `subagent finished (${stopReason}) without a final report`, isError: true };
  }
  return { output: report, isError: stopReason !== "end_turn" };
}
