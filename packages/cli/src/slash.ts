import type { SkillInfo } from "@minerva/protocol";

/**
 * Slash-input dispatch, extracted pure so it's testable without Ink.
 * Built-ins always win a name collision with a skill: a project must not be
 * able to rebind /exit or /config out from under the user.
 */

const BUILTIN_COMMANDS = [
  "help",
  "config",
  "mode",
  "compact",
  "sessions",
  "new",
  "exit",
  "quit",
] as const;

export type SlashResolution =
  | { kind: "builtin"; command: string; argument: string }
  | { kind: "skill"; name: string }
  | { kind: "unknown"; command: string };

export function resolveSlashInput(input: string, skills: SkillInfo[]): SlashResolution {
  const [command = "", ...rest] = input.slice(1).split(/\s+/);
  const argument = rest.join(" ");
  if ((BUILTIN_COMMANDS as readonly string[]).includes(command)) {
    return { kind: "builtin", command, argument };
  }
  if (skills.some((skill) => skill.name === command)) {
    return { kind: "skill", name: command };
  }
  return { kind: "unknown", command };
}

/** Extra /help lines for the session's skills; "" when there are none. */
export function skillsHelp(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  const width = Math.max(...skills.map((skill) => skill.name.length)) + 1;
  return [
    "",
    "Skills (from .minerva/skills and ~/.minerva/skills):",
    ...skills.map((skill) => `/${skill.name.padEnd(width)} ${skill.description}`),
  ].join("\n");
}
