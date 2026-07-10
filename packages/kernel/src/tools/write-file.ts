import { dirname } from "node:path";
import type { KernelTool } from "./types";
import { asRecord, requireString, resolveWithinWorkspace } from "./types";

export const writeFileTool: KernelTool = {
  name: "write_file",
  description:
    "Create or overwrite a text file inside the working directory. Parent " +
    "directories are created as needed. Prefer edit_file for changing existing " +
    "files; use bash for files outside the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  kind: "edit",
  readOnly: false,
  title(input) {
    return `Write ${requireString(asRecord(input), "path")}`;
  },
  async execute(input, context) {
    const record = asRecord(input);
    // acceptEdits mode auto-allows edit-kind tools, so confinement to the
    // workspace is the backstop against writes landing anywhere on disk.
    const path = resolveWithinWorkspace(context.cwd, requireString(record, "path"));
    const content = record.content;
    if (typeof content !== "string") {
      throw new Error("missing required string parameter: content");
    }
    await context.runtime.mkdirp(dirname(path));
    await context.runtime.writeTextFile(path, content);
    return { output: `Wrote ${content.length} characters to ${path}` };
  },
};
