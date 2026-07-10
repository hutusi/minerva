import { glob } from "tinyglobby";
import type { KernelTool } from "./types";
import { asRecord, requireString, resolveWithinWorkspace } from "./types";

const MAX_FILES = 500;
const MAX_MATCHES = 100;
const MAX_FILE_CHARS = 1_000_000;
const MAX_LINE_CHARS = 500;
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const grepTool: KernelTool = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Searches the " +
    "working directory (or an optional subdirectory), optionally filtered by an " +
    "include glob (e.g. **/*.ts). Returns path:line: text matches, capped at 100.",
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
    let regex: RegExp;
    try {
      regex = new RegExp(requireString(record, "pattern"));
    } catch (error) {
      return {
        output: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    // readOnly ⇒ policy-allowed with no prompt ⇒ must stay inside the workspace.
    const base = resolveWithinWorkspace(
      context.cwd,
      typeof record.path === "string" ? record.path : ".",
    );
    const files = await glob(typeof record.include === "string" ? record.include : "**/*", {
      cwd: base,
      ignore: DEFAULT_IGNORE,
      onlyFiles: true,
    });
    files.sort();

    const matches: string[] = [];
    let scanned = 0;
    let skipped = 0;
    for (const file of files) {
      if (scanned >= MAX_FILES || matches.length >= MAX_MATCHES) {
        skipped = files.length - scanned;
        break;
      }
      scanned += 1;
      let content: string;
      try {
        content = await context.runtime.readTextFile(`${base}/${file}`);
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_CHARS || content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length && matches.length < MAX_MATCHES; index++) {
        const line = lines[index] ?? "";
        if (regex.test(line)) {
          matches.push(`${file}:${index + 1}: ${line.slice(0, MAX_LINE_CHARS).trimEnd()}`);
        }
      }
    }

    if (matches.length === 0) return { output: "No matches found." };
    const notes: string[] = [];
    if (matches.length >= MAX_MATCHES) notes.push(`capped at ${MAX_MATCHES} matches`);
    if (skipped > 0) notes.push(`${skipped} files not scanned`);
    const suffix = notes.length > 0 ? `\n… (${notes.join("; ")})` : "";
    return { output: matches.join("\n") + suffix };
  },
};
