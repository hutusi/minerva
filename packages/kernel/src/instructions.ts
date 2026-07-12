import { join } from "node:path";
import { type BoundedRead, isNotFoundError, type Runtime } from "./runtime";
import { truncateCodePointSafe } from "./text";
// Direct module import (not the ./tools barrel) to avoid an import cycle.
import { readConfinedTextFilePrefix } from "./tools/types";

/**
 * AGENTS.md project instructions (agents.md open standard): user-authored
 * guidance appended to the system prompt at session establish. Two locations
 * only in v1 — `<dataDir>/AGENTS.md` (global, mirrors globalSettingsPath) and
 * `<cwd>/AGENTS.md` (project root); nested per-directory files are out of
 * scope. The composed text is never persisted: the system prompt is rebuilt
 * per prompt, so replayed sessions pick instructions up like new ones.
 */

export interface InstructionFile {
  path: string;
  scope: "global" | "project";
  /** Full on-disk size in bytes (the loaded content may be truncated). */
  bytes: number;
  truncated: boolean;
}

export interface ProjectInstructions {
  /** Composed markdown block to append to the system prompt; "" when none found. */
  text: string;
  files: InstructionFile[];
  warnings: string[];
}

/**
 * Per-file cap keeps a runaway AGENTS.md from crowding out the conversation:
 * instructions ride in EVERY request, unlike tool output which is transient.
 */
export const MAX_INSTRUCTIONS_CHARS = 24_000;

/**
 * Byte budget for the bounded read: 4× the char cap guarantees the char-cap
 * slice is always the visible cut (worst case 3-byte UTF-8 chars still yield
 * more than MAX_INSTRUCTIONS_CHARS UTF-16 units), while a multi-gigabyte
 * file never gets buffered.
 */
const INSTRUCTIONS_BYTE_BUDGET = 4 * MAX_INSTRUCTIONS_CHARS;

export async function loadProjectInstructions(
  runtime: Runtime,
  dataDir: string,
  cwd: string,
): Promise<ProjectInstructions> {
  const candidates: Array<{ path: string; scope: "global" | "project" }> = [
    { path: join(dataDir, "AGENTS.md"), scope: "global" },
    { path: join(cwd, "AGENTS.md"), scope: "project" },
  ];

  const files: InstructionFile[] = [];
  const warnings: string[] = [];
  const sections: string[] = [];

  for (const candidate of candidates) {
    let raw: BoundedRead;
    try {
      // Project files are repo-controlled: a symlinked AGENTS.md must not
      // pull content from outside the workspace into the prompt (the
      // confined read pins the inode it actually read). The global file is
      // user-owned (like stored API keys) — dotfile symlinks stay legitimate.
      raw =
        candidate.scope === "project"
          ? await readConfinedTextFilePrefix(runtime, cwd, candidate.path, INSTRUCTIONS_BYTE_BUDGET)
          : await runtime.readTextFilePrefix(candidate.path, INSTRUCTIONS_BYTE_BUDGET);
    } catch (error) {
      // Absent is the normal case; anything else (EACCES, EISDIR, an
      // outside-the-workspace symlink) is worth a warning but must not fail
      // session start.
      if (!isNotFoundError(error)) {
        warnings.push(
          `could not read ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    const trimmed = raw.text.trim();
    if (trimmed.length === 0) continue;
    const truncated = raw.truncated || trimmed.length > MAX_INSTRUCTIONS_CHARS;
    const content = truncated
      ? `${truncateCodePointSafe(trimmed, MAX_INSTRUCTIONS_CHARS)}\n[truncated: AGENTS.md is ${raw.totalBytes} bytes; loaded the first ${MAX_INSTRUCTIONS_CHARS} characters]`
      : trimmed;
    files.push({ path: candidate.path, scope: candidate.scope, bytes: raw.totalBytes, truncated });
    sections.push(`## From ${candidate.path} (${candidate.scope})\n\n${content}`);
  }

  if (sections.length === 0) return { text: "", files, warnings };
  const text = [
    "# Project instructions",
    "",
    "The following instructions come from AGENTS.md files and take precedence over default behavior.",
    "",
    sections.join("\n\n"),
  ].join("\n");
  return { text, files, warnings };
}
