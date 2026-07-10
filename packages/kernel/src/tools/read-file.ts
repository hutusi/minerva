import { resolve } from "node:path";
import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

const MAX_CHARS = 50_000;

export const readFileTool: KernelTool = {
  name: "read_file",
  description:
    "Read a text file. The path may be absolute or relative to the working directory. " +
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
    const path = resolve(context.cwd, requireString(asRecord(input), "path"));
    const content = await context.runtime.readTextFile(path);
    if (content.length > MAX_CHARS) {
      return {
        output: `${content.slice(0, MAX_CHARS)}\n[truncated: file is ${content.length} characters]`,
      };
    }
    return { output: content };
  },
};
