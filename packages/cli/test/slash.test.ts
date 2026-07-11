import { describe, expect, test } from "bun:test";
import type { SkillInfo } from "@minerva/protocol";
import { resolveSlashInput, skillsHelp } from "../src/slash";

const skills: SkillInfo[] = [
  { name: "deploy", description: "Ship it safely", source: "project" },
  // A skill shadowing a built-in: the built-in must win.
  { name: "help", description: "Custom help", source: "project" },
];

describe("resolveSlashInput", () => {
  test("built-in commands resolve with their argument", () => {
    expect(resolveSlashInput("/mode plan", skills)).toEqual({
      kind: "builtin",
      command: "mode",
      argument: "plan",
    });
  });

  test("a skill name resolves to a skill invocation", () => {
    expect(resolveSlashInput("/deploy to staging", skills)).toEqual({
      kind: "skill",
      name: "deploy",
    });
  });

  test("built-ins win a name collision with a skill", () => {
    expect(resolveSlashInput("/help", skills)).toEqual({
      kind: "builtin",
      command: "help",
      argument: "",
    });
  });

  test("anything else is unknown", () => {
    expect(resolveSlashInput("/nope", skills)).toEqual({ kind: "unknown", command: "nope" });
    expect(resolveSlashInput("/deploy", [])).toEqual({ kind: "unknown", command: "deploy" });
  });
});

describe("skillsHelp", () => {
  test("lists each skill as a slash command", () => {
    const help = skillsHelp(skills);
    expect(help).toContain("/deploy");
    expect(help).toContain("Ship it safely");
  });

  test("is empty with no skills", () => {
    expect(skillsHelp([])).toBe("");
  });
});
