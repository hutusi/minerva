import { join } from "node:path";
import { isNotFoundError, type Runtime } from "./runtime";
// Direct module import (not the ./tools barrel) to avoid an import cycle
// with tools/skill.ts, which imports this module.
import { resolveWithinWorkspace } from "./tools/types";

/**
 * Skills: user-authored, reusable instructions as `skills/<name>/SKILL.md`
 * under the data dir (global) and `.minerva/skills/` (project), with YAML-ish
 * frontmatter carrying `name` and `description`. Only frontmatter is read at
 * discovery; bodies stay on disk until a skill is invoked (progressive
 * disclosure — a large skill library must not tax every request).
 */

export interface Skill {
  name: string;
  description: string;
  source: "global" | "project";
  /** Absolute path to SKILL.md (body read lazily at invoke time). */
  path: string;
  /**
   * Root the skill file must stay inside (repo-controlled project skills);
   * re-checked at every read so a symlink swapped in after discovery can't
   * pull outside files into the prompt. Unset for user-owned global skills.
   */
  confineTo?: string | undefined;
}

export interface SkillRegistry {
  skills: Skill[];
  warnings: string[];
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The CLI's built-in slash commands. A skill may carry one of these names —
 * the CLI's dispatch always prefers the built-in, so it would only ever be
 * reachable from other frontends — but that near-invisibility is confusing
 * enough to warn about at load time.
 */
const RESERVED_NAMES = new Set([
  "help",
  "config",
  "mode",
  "compact",
  "sessions",
  "new",
  "exit",
  "quit",
]);

/** Cap matches read_file's output cap: a skill body is model input, not prose. */
export const MAX_SKILL_BODY_CHARS = 50_000;

/** Byte budget for bounded body reads; 4× the char cap so the char-cap slice
 * is always the visible cut while a huge file is never fully buffered. */
const SKILL_BODY_BYTE_BUDGET = 4 * MAX_SKILL_BODY_CHARS;

/** Frontmatter must fit here; discovery never reads bodies. */
const FRONTMATTER_PREFIX_BYTES = 8 * 1024;

/** Descriptions ride in skills/list results and the skill tool listing. */
const MAX_SKILL_DESCRIPTION_CHARS = 500;

/** Caps discovery I/O per root, not just registry size. */
const MAX_SKILLS_PER_ROOT = 64;

/**
 * Minimal frontmatter parser: a leading `---` fence, single-line
 * `key: value` string pairs (optional surrounding quotes), closing `---`.
 * Deliberately not full YAML — no new dependency, and the two keys skills
 * need are flat strings. Multiline scalars are a documented v1 limitation.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match || match[1] === undefined) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length) };
}

export async function loadSkills(
  runtime: Runtime,
  dataDir: string,
  cwd: string,
): Promise<SkillRegistry> {
  const roots: Array<{ dir: string; source: "global" | "project" }> = [
    { dir: join(dataDir, "skills"), source: "global" },
    { dir: join(cwd, ".minerva", "skills"), source: "project" },
  ];
  const warnings: string[] = [];
  // Global first, project second: a project skill overrides a same-named
  // global one, mirroring the mcpServers per-name merge.
  const byName = new Map<string, Skill>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await runtime.readdir(root.dir);
    } catch (error) {
      if (!isNotFoundError(error)) {
        warnings.push(
          `could not read skills directory ${root.dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    const sorted = entries.sort();
    if (sorted.length > MAX_SKILLS_PER_ROOT) {
      warnings.push(
        `skills directory ${root.dir} has ${sorted.length} entries; only the first ${MAX_SKILLS_PER_ROOT} are scanned`,
      );
      sorted.length = MAX_SKILLS_PER_ROOT;
    }
    for (const entry of sorted) {
      const path = join(root.dir, entry, "SKILL.md");
      // Project skills are repo-controlled: a symlink must not reach outside
      // the workspace. Global skills are user-owned and stay unconfined.
      if (root.source === "project") {
        try {
          await resolveWithinWorkspace(runtime, cwd, path);
        } catch (error) {
          warnings.push(
            `skipping ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      let prefix: { text: string; truncated: boolean };
      try {
        // Discovery only ever reads enough for frontmatter — bodies stay on
        // disk until a skill is invoked.
        prefix = await runtime.readTextFilePrefix(path, FRONTMATTER_PREFIX_BYTES);
      } catch (error) {
        // A stray file (ENOTDIR) or a dir without SKILL.md (ENOENT) is not a
        // skill; anything else is worth a warning.
        if (!isNotFoundError(error) && !isNotDirError(error)) {
          warnings.push(
            `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      const { meta } = parseFrontmatter(prefix.text);
      if (prefix.truncated && Object.keys(meta).length === 0 && prefix.text.startsWith("---")) {
        warnings.push(
          `skill at ${path}: frontmatter not closed within the first ${FRONTMATTER_PREFIX_BYTES} bytes — skipped`,
        );
        continue;
      }
      const name = meta.name ?? entry;
      if (!SKILL_NAME_PATTERN.test(name)) {
        warnings.push(`skill at ${path} has an invalid name "${name}" — skipped`);
        continue;
      }
      const description = clipDescription(meta.description?.trim());
      if (!description) {
        warnings.push(`skill "${name}" at ${path} has no description in its frontmatter — skipped`);
        continue;
      }
      if (RESERVED_NAMES.has(name.toLowerCase())) {
        warnings.push(
          `skill "${name}" shadows a built-in slash command; /${name} in the CLI runs the built-in`,
        );
      }
      byName.set(name, {
        name,
        description,
        source: root.source,
        path,
        ...(root.source === "project" ? { confineTo: cwd } : {}),
      });
    }
  }

  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** A skill's instructions with frontmatter stripped, capped for model input. */
export async function readSkillBody(runtime: Runtime, skill: Skill): Promise<string> {
  if (skill.confineTo) {
    // Re-check at invoke time: discovery-time confinement is stale the moment
    // a symlink is swapped underneath it. Same check-then-open TOCTOU stance
    // that resolveWithinWorkspace documents for tool paths.
    await resolveWithinWorkspace(runtime, skill.confineTo, skill.path);
  }
  const { text, truncated, totalBytes } = await runtime.readTextFilePrefix(
    skill.path,
    SKILL_BODY_BYTE_BUDGET,
  );
  const body = parseFrontmatter(text).body.trim();
  if (!truncated && body.length <= MAX_SKILL_BODY_CHARS) return body;
  return `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n[truncated: SKILL.md is ${totalBytes} bytes; loaded the first ${MAX_SKILL_BODY_CHARS} characters]`;
}

function clipDescription(description: string | undefined): string | undefined {
  if (!description || description.length <= MAX_SKILL_DESCRIPTION_CHARS) return description;
  // Code-point-safe cut: never split a surrogate pair.
  return `${[...description].slice(0, MAX_SKILL_DESCRIPTION_CHARS).join("")}…`;
}

function isNotDirError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOTDIR";
}
