import { readSkillBody, type SkillRegistry } from "../skills";
import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

/**
 * The model's doorway to skills (progressive disclosure): the tool
 * description advertises names + one-line descriptions only; a skill's full
 * instructions are read from disk when invoked. Composed per session in
 * #toolsFor — like MCP tools — because the registry depends on the cwd.
 */

const DESCRIPTION_CLIP = 200;

export function createSkillTool(registry: SkillRegistry): KernelTool {
  const listing = registry.skills
    .map((skill) => `- ${skill.name}: ${clip(skill.description)}`)
    .join("\n");
  return {
    name: "skill",
    description:
      "Load a skill — reusable expert instructions for a specific kind of task. " +
      "Invoke it when a listed skill matches the user's request, then follow the " +
      `returned instructions.\nAvailable skills:\n${listing}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the skill to load" },
      },
      required: ["name"],
    },
    kind: "read",
    // Reads user-authored markdown from the same trust class as project
    // settings; deny rules ("skill") can still block it.
    readOnly: true,
    title(input) {
      try {
        return `Skill: ${requireString(asRecord(input), "name")}`;
      } catch {
        return "Skill";
      }
    },
    async execute(input, context) {
      const name = requireString(asRecord(input), "name");
      const skill = registry.skills.find((candidate) => candidate.name === name);
      if (!skill) {
        const available = registry.skills.map((candidate) => candidate.name).join(", ");
        return { output: `Unknown skill: ${name}. Available: ${available}`, isError: true };
      }
      const body = await readSkillBody(context.runtime, skill);
      return { output: body || "(the skill file is empty)" };
    },
  };
}

function clip(text: string): string {
  return text.length > DESCRIPTION_CLIP ? `${text.slice(0, DESCRIPTION_CLIP)}…` : text;
}
