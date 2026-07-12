import { describe, expect, test } from "bun:test";
import type { SkillInfo } from "@minerva/protocol";
import { slashSuggestions } from "../src/suggest";

const SKILLS: SkillInfo[] = [
  { name: "commit", description: "Commit the staged changes", source: "project" },
  { name: "helpdesk", description: "File a ticket", source: "global" },
];

describe("slashSuggestions", () => {
  test("a bare slash offers commands, capped at six", () => {
    const suggestions = slashSuggestions("/", SKILLS);
    expect(suggestions.length).toBe(6);
    expect(suggestions[0]?.name).toBe("help");
  });

  test("prefix filters across builtins and skills", () => {
    expect(slashSuggestions("/he", SKILLS).map((s) => s.name)).toEqual(["help", "helpdesk"]);
    expect(slashSuggestions("/com", SKILLS).map((s) => s.name)).toEqual(["compact", "commit"]);
  });

  test("skill suggestions carry their descriptions", () => {
    expect(slashSuggestions("/commit", SKILLS)).toEqual([
      { name: "commit", description: "Commit the staged changes" },
    ]);
  });

  test("no suggestions for plain text, arguments, or non-matches", () => {
    expect(slashSuggestions("hello", SKILLS)).toEqual([]);
    expect(slashSuggestions("/mode plan", SKILLS)).toEqual([]);
    expect(slashSuggestions("/zzz", SKILLS)).toEqual([]);
    expect(slashSuggestions("", SKILLS)).toEqual([]);
  });
});
