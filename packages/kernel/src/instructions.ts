import { join } from "node:path";
import { isNotFoundError, type Runtime } from "./runtime";

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
    let raw: string;
    try {
      raw = await runtime.readTextFile(candidate.path);
    } catch (error) {
      // Absent is the normal case; anything else (EACCES, EISDIR) is worth a
      // warning but must not fail session start.
      if (!isNotFoundError(error)) {
        warnings.push(
          `could not read ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const truncated = trimmed.length > MAX_INSTRUCTIONS_CHARS;
    const content = truncated
      ? `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n[truncated: AGENTS.md is ${trimmed.length} characters]`
      : trimmed;
    files.push({ path: candidate.path, scope: candidate.scope, bytes: raw.length, truncated });
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
