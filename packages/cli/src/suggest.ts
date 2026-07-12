import type { SkillInfo } from "@minerva/protocol";
import { BUILTIN_COMMANDS } from "./slash";

/**
 * Slash-command autocomplete, pure so it's testable without Ink. Suggestions
 * exist only while the draft is a bare `/word` — once an argument (or any
 * whitespace) follows, the command is settled and the dropdown closes.
 */

export interface Suggestion {
  name: string;
  description: string;
}

/** Dropdown blurbs for built-ins; skills bring their own descriptions. */
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  help: "show help",
  config: "choose provider, API key, and model",
  mode: "show or set the session mode",
  compact: "summarize the conversation and reset the model context",
  sessions: "pick a recent session for this directory",
  resume: "pick a recent session for this directory",
  new: "start a fresh session",
  exit: "quit",
  quit: "quit",
};

const MAX_SUGGESTIONS = 6;

export function slashSuggestions(draft: string, skills: SkillInfo[]): Suggestion[] {
  if (!/^\/\S*$/.test(draft)) return [];
  const prefix = draft.slice(1);
  const builtins = BUILTIN_COMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
    name,
    description: BUILTIN_DESCRIPTIONS[name] ?? "",
  }));
  const fromSkills = skills
    .filter((skill) => skill.name.startsWith(prefix))
    .map((skill) => ({ name: skill.name, description: skill.description }));
  return [...builtins, ...fromSkills].slice(0, MAX_SUGGESTIONS);
}
