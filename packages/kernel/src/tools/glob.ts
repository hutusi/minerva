import { glob } from "tinyglobby";
import type { KernelTool } from "./types";
import { asRecord, requireString, resolveWithinWorkspace } from "./types";

const MAX_RESULTS = 200;
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const globTool: KernelTool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. src/**/*.ts), relative to the " +
    "working directory or an optional subdirectory. Results are capped at 200 " +
    "paths; node_modules and .git are ignored.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against" },
      path: { type: "string", description: "Directory to search in (default: working directory)" },
    },
    required: ["pattern"],
  },
  kind: "search",
  readOnly: true,
  title(input) {
    return `Glob ${requireString(asRecord(input), "pattern")}`;
  },
  async execute(input, context) {
    const record = asRecord(input);
    const pattern = requireString(record, "pattern");
    // readOnly ⇒ policy-allowed with no prompt ⇒ must stay inside the workspace.
    const base = resolveWithinWorkspace(
      context.cwd,
      typeof record.path === "string" ? record.path : ".",
    );
    const matches = await glob(pattern, {
      cwd: base,
      ignore: DEFAULT_IGNORE,
      onlyFiles: true,
    });
    if (matches.length === 0) return { output: "No files matched." };
    matches.sort();
    const shown = matches.slice(0, MAX_RESULTS);
    const suffix =
      matches.length > shown.length
        ? `\n… (${matches.length - shown.length} more matches not shown)`
        : "";
    return { output: shown.join("\n") + suffix };
  },
};
