import { resolveRgPath } from "./ripgrep";
import type { KernelTool } from "./types";
import { asRecord, ensureConfinedPattern, requireString, resolveWithinWorkspace } from "./types";

const MAX_RESULTS = 200;
const GLOB_TIMEOUT_MS = 30_000;

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
    // readOnly ⇒ policy-allowed with no prompt ⇒ must stay inside the workspace.
    const pattern = ensureConfinedPattern(requireString(record, "pattern"));
    const base = await resolveWithinWorkspace(
      context.runtime,
      context.cwd,
      typeof record.path === "string" ? record.path : ".",
    );
    // `rg --files` lists files without following symlinks (no -L). Exclude
    // node_modules/.git at any depth, after the include pattern so the
    // exclusions win. Spawned by argv, so the pattern is never shell-interpreted.
    const result = await context.runtime.runProcess(
      await resolveRgPath(),
      ["--files", "--no-ignore", "-g", pattern, "-g", "!**/node_modules/**", "-g", "!**/.git/**"],
      { cwd: base, timeoutMs: GLOB_TIMEOUT_MS, signal: context.signal },
    );
    if (result.aborted) return { output: "Search cancelled by user.", isError: true };
    if (result.timedOut) return { output: "Search timed out.", isError: true };
    if (result.exitCode === 2) {
      return { output: `Invalid glob: ${result.stderr.trim() || "ripgrep error"}`, isError: true };
    }

    const matches = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.startsWith("./") ? line.slice(2) : line));
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
