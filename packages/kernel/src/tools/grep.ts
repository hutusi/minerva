import { rgPath } from "@vscode/ripgrep";
import type { KernelTool } from "./types";
import { asRecord, ensureConfinedPattern, requireString, resolveWithinWorkspace } from "./types";

const MAX_MATCHES = 100;
const MAX_LINE_CHARS = 500;
// Skip files larger than this (a real pre-read bound, unlike reading then
// discarding). ripgrep applies it during traversal.
const MAX_FILESIZE = "1M";
const GREP_TIMEOUT_MS = 30_000;

export const grepTool: KernelTool = {
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep/Rust syntax). " +
    "Searches the working directory (or an optional subdirectory), optionally " +
    "filtered by an include glob (e.g. **/*.ts). Returns path:line: text " +
    "matches, capped at 100.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "Directory to search in (default: working directory)" },
      include: { type: "string", description: "Only search files matching this glob" },
    },
    required: ["pattern"],
  },
  kind: "search",
  readOnly: true,
  title(input) {
    return `Grep /${requireString(asRecord(input), "pattern")}/`;
  },
  async execute(input, context) {
    const record = asRecord(input);
    const pattern = requireString(record, "pattern");
    // readOnly ⇒ policy-allowed with no prompt ⇒ must stay inside the workspace.
    const base = await resolveWithinWorkspace(
      context.runtime,
      context.cwd,
      typeof record.path === "string" ? record.path : ".",
    );
    const args = [
      "--json",
      "--max-filesize",
      MAX_FILESIZE,
      // Preserve the previous visibility: search everything except node_modules
      // and .git (don't defer to .gitignore, which would silently shrink
      // results). ripgrep does not follow symlinks unless -L is passed.
      "--no-ignore",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
    ];
    if (typeof record.include === "string") {
      args.push("-g", ensureConfinedPattern(record.include));
    }
    // -e takes the pattern as a value (never a flag, even if it starts with -);
    // spawning by argv means it is never interpreted by a shell.
    args.push("-e", pattern, "--", ".");

    const result = await context.runtime.runProcess(rgPath, args, {
      cwd: base,
      timeoutMs: GREP_TIMEOUT_MS,
      signal: context.signal,
    });
    if (result.aborted) return { output: "Search cancelled by user.", isError: true };
    if (result.timedOut) return { output: "Search timed out.", isError: true };
    // rg: 0 = matches, 1 = no matches, 2 = error (e.g. an invalid pattern).
    if (result.exitCode === 2) {
      return {
        output: `Invalid search: ${result.stderr.trim() || "ripgrep error"}`,
        isError: true,
      };
    }

    const matches: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (matches.length >= MAX_MATCHES) break;
      if (!line.trim()) continue;
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      const path = event.data.path.text;
      const lineNumber = event.data.line_number;
      const text = event.data.lines.text ?? "";
      if (typeof path !== "string" || typeof lineNumber !== "number") continue;
      const trimmed = text
        .replace(/\r?\n$/, "")
        .slice(0, MAX_LINE_CHARS)
        .trimEnd();
      matches.push(`${normalize(path)}:${lineNumber}: ${trimmed}`);
    }

    if (matches.length === 0) return { output: "No matches found." };
    const suffix = matches.length >= MAX_MATCHES ? `\n… (capped at ${MAX_MATCHES} matches)` : "";
    return { output: matches.join("\n") + suffix };
  },
};

interface RgEvent {
  type: string;
  data: {
    path: { text?: string };
    line_number?: number;
    lines: { text?: string };
  };
}

function normalize(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
