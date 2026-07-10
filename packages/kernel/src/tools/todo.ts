import type { PlanEntry, PlanEntryStatus } from "@minerva/protocol";
import type { KernelTool } from "./types";
import { asRecord } from "./types";

const STATUSES: PlanEntryStatus[] = ["pending", "in_progress", "completed"];
const PRIORITIES = ["high", "medium", "low"] as const;

export const todoTool: KernelTool = {
  name: "todo_write",
  description:
    "Replace the session todo list. Use it to plan multi-step work and keep the " +
    "user informed: mark items in_progress when you start them and completed when " +
    "done. Always send the complete list, not a diff.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete todo list",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "The task, in imperative form" },
            status: { type: "string", enum: STATUSES },
            priority: { type: "string", enum: [...PRIORITIES] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  kind: "think",
  // Touches only session state, never the machine — safe to auto-allow.
  readOnly: true,
  title(input) {
    const entries = parseEntries(input);
    const done = entries.filter((entry) => entry.status === "completed").length;
    return `Update todos (${done}/${entries.length} done)`;
  },
  async execute(input, context) {
    const entries = parseEntries(input);
    if (!context.updateTodos) {
      throw new Error("todo tracking is not available in this context");
    }
    context.updateTodos(entries);
    return {
      output:
        entries.length === 0 ? "Todo list cleared." : `Todo list updated:\n${render(entries)}`,
    };
  },
};

function parseEntries(input: unknown): PlanEntry[] {
  const record = asRecord(input);
  if (!Array.isArray(record.todos)) {
    throw new Error("missing required array parameter: todos");
  }
  return record.todos.map((raw, index) => {
    const todo = asRecord(raw);
    if (typeof todo.content !== "string" || todo.content.length === 0) {
      throw new Error(`todos[${index}].content must be a non-empty string`);
    }
    if (!STATUSES.includes(todo.status as PlanEntryStatus)) {
      throw new Error(`todos[${index}].status must be one of ${STATUSES.join(", ")}`);
    }
    const priority = PRIORITIES.includes(todo.priority as (typeof PRIORITIES)[number])
      ? (todo.priority as PlanEntry["priority"])
      : "medium";
    return { content: todo.content, status: todo.status as PlanEntryStatus, priority };
  });
}

function render(entries: PlanEntry[]): string {
  const mark = { pending: " ", in_progress: "~", completed: "x" } as const;
  return entries.map((entry) => `[${mark[entry.status]}] ${entry.content}`).join("\n");
}
