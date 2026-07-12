import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

/**
 * Spawn a subagent (see ../subagent.ts). readOnly is deliberate: spawning is
 * pure orchestration — every mutating thing the child does is judged by the
 * PARENT's permission engine and mode (plan mode still blocks child writes,
 * default mode still prompts), so gating the spawn itself would only
 * double-prompt. A `deny: ["task"]` rule still works: deny outranks the
 * read-only fast path in the permission engine.
 */
export const taskTool: KernelTool = {
  name: "task",
  description:
    "Launch a subagent: a scoped child agent with its own context and the " +
    "same tools (minus task and todo_write), useful for self-contained " +
    "side quests — a broad search, an isolated analysis — whose details " +
    "would bloat this conversation. It runs to completion and only its " +
    "final report returns, so the prompt must be standalone: include all " +
    "needed context and say exactly what to return. Tasks run sequentially " +
    "and cannot spawn further tasks.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "3-7 word progress label shown to the user",
      },
      prompt: {
        type: "string",
        description: "Standalone instructions for the subagent, including what to return",
      },
    },
    required: ["description", "prompt"],
  },
  kind: "other",
  readOnly: true,
  title(input) {
    return `task: ${requireString(asRecord(input), "description")}`;
  },
  async execute(input, context) {
    const record = asRecord(input);
    const description = requireString(record, "description");
    const prompt = requireString(record, "prompt");
    if (!context.runSubagent) {
      return { output: "subagents are not available in this context", isError: true };
    }
    return context.runSubagent({ description, prompt });
  },
};
