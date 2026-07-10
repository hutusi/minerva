import { resolve } from "node:path";
import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

export const editFileTool: KernelTool = {
  name: "edit_file",
  description:
    "Edit a text file by exact string replacement. old_string must match exactly one " +
    "location in the file, including whitespace; include enough surrounding context to " +
    "make it unique.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  kind: "edit",
  readOnly: false,
  title(input) {
    return `Edit ${requireString(asRecord(input), "path")}`;
  },
  async execute(input, context) {
    const record = asRecord(input);
    const path = resolve(context.cwd, requireString(record, "path"));
    const oldString = requireString(record, "old_string");
    const newString = typeof record.new_string === "string" ? record.new_string : "";

    const content = await context.runtime.readTextFile(path);
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return { output: `old_string not found in ${path}`, isError: true };
    }
    if (occurrences > 1) {
      return {
        output: `old_string matches ${occurrences} locations in ${path}; add more context to make it unique`,
        isError: true,
      };
    }
    await context.runtime.writeTextFile(path, content.replace(oldString, newString));
    return { output: `Edited ${path}` };
  },
};
