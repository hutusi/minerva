import type { KernelTool } from "./types";
import { asRecord, requireString, resolveWithinWorkspace } from "./types";

const MAX_CHARS = 50_000;

export const readFileTool: KernelTool = {
  name: "read_file",
  description:
    "Read a text file inside the working directory. The path may be absolute or " +
    "relative to the working directory, but must stay within it. " +
    "Output is truncated after 50k characters.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
  kind: "read",
  readOnly: true,
  title(input) {
    return `Read ${requireString(asRecord(input), "path")}`;
  },
  async execute(input, context) {
    // read_file is auto-allowed by policy (readOnly), so it must not be able
    // to reach outside the workspace — no permission prompt would fire.
    const path = resolveWithinWorkspace(context.cwd, requireString(asRecord(input), "path"));
    const content = await context.runtime.readTextFile(path);
    if (content.length > MAX_CHARS) {
      return {
        output: `${content.slice(0, MAX_CHARS)}\n[truncated: file is ${content.length} characters]`,
      };
    }
    return { output: content };
  },
};
