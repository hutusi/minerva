import { join } from "node:path";
import { isNotFoundError, type Runtime } from "./runtime";

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
    for (const entry of entries.sort()) {
      const path = join(root.dir, entry, "SKILL.md");
      let raw: string;
      try {
        raw = await runtime.readTextFile(path);
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
      const { meta } = parseFrontmatter(raw);
      const name = meta.name ?? entry;
      if (!SKILL_NAME_PATTERN.test(name)) {
        warnings.push(`skill at ${path} has an invalid name "${name}" — skipped`);
        continue;
      }
      const description = meta.description?.trim();
      if (!description) {
        warnings.push(`skill "${name}" at ${path} has no description in its frontmatter — skipped`);
        continue;
      }
      if (RESERVED_NAMES.has(name.toLowerCase())) {
        warnings.push(
          `skill "${name}" shadows a built-in slash command; /${name} in the CLI runs the built-in`,
        );
      }
      byName.set(name, { name, description, source: root.source, path });
    }
  }

  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** A skill's instructions with frontmatter stripped, capped for model input. */
export async function readSkillBody(runtime: Runtime, skill: Skill): Promise<string> {
  const raw = await runtime.readTextFile(skill.path);
  const body = parseFrontmatter(raw).body.trim();
  if (body.length <= MAX_SKILL_BODY_CHARS) return body;
  return `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n[truncated: SKILL.md body is ${body.length} characters]`;
}

function isNotDirError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOTDIR";
}
