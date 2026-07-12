import type { KernelTool } from "./types";
import { asRecord, diffContent, requireString, resolveWithinWorkspace } from "./types";

export const editFileTool: KernelTool = {
  name: "edit_file",
  description:
    "Edit a text file inside the working directory by exact string replacement. " +
    "old_string must match exactly one location in the file, including whitespace; " +
    "include enough surrounding context to make it unique.",
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
    // acceptEdits mode auto-allows edit-kind tools, so confinement to the
    // workspace is the backstop against edits landing anywhere on disk.
    const path = await resolveWithinWorkspace(
      context.runtime,
      context.cwd,
      requireString(record, "path"),
    );
    const oldString = requireString(record, "old_string");
    // Unlike requireString, the empty string is a legal new_string (deletion)
    // — but a missing/non-string value must fail, not silently delete.
    const newString = record.new_string;
    if (typeof newString !== "string") {
      throw new Error("missing required string parameter: new_string");
    }

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
    // Replacer function: a plain string argument would interpret $-patterns
    // ($$, $&, $') in new_string and silently corrupt the file.
    const updated = content.replace(oldString, () => newString);
    await context.runtime.writeTextFile(path, updated);
    const diff = diffContent(path, content, updated);
    return { output: `Edited ${path}`, ...(diff ? { content: diff } : {}) };
  },
};
