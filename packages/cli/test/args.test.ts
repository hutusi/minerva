import { describe, expect, test } from "bun:test";
import { parseCliArgs, usage } from "../src/args";

describe("parseCliArgs", () => {
  test("no arguments runs the TUI with no model override", () => {
    expect(parseCliArgs([])).toEqual({
      kind: "run",
      args: { command: "tui", model: null, resume: null, profile: null, print: null, mode: null },
    });
  });

  test("acp command and flags compose in any order", () => {
    const args = {
      command: "acp" as const,
      model: "openai/gpt-5.2",
      resume: null,
      profile: null,
      print: null,
      mode: null,
    };
    expect(parseCliArgs(["acp", "-m", "openai/gpt-5.2"])).toEqual({ kind: "run", args });
    expect(parseCliArgs(["-m", "openai/gpt-5.2", "acp"])).toEqual({ kind: "run", args });
  });

  test("-p captures a prompt, or defers to stdin when followed by a flag", () => {
    expect(parseCliArgs(["-p", "say hi"])).toMatchObject({
      args: { print: { prompt: "say hi" }, mode: null },
    });
    expect(parseCliArgs(["-p", "--mode", "auto"])).toMatchObject({
      args: { print: { prompt: null }, mode: "auto" },
    });
    expect(parseCliArgs(["--print"])).toMatchObject({
      args: { print: { prompt: null } },
    });
    expect(parseCliArgs(["-p", "explain", "-m", "openai/gpt-5.2"])).toMatchObject({
      args: { print: { prompt: "explain" }, model: "openai/gpt-5.2" },
    });
  });

  test("--mode without -p and print+acp combinations are errors", () => {
    expect(parseCliArgs(["--mode", "auto"])).toEqual({
      kind: "error",
      message: "--mode requires -p/--print (use /mode in the TUI)",
    });
    expect(parseCliArgs(["--mode"])).toEqual({
      kind: "error",
      message: "--mode requires a mode id",
    });
    expect(parseCliArgs(["acp", "-p", "hi"])).toEqual({
      kind: "error",
      message: "acp and --print are mutually exclusive",
    });
  });

  test("--profile carries the name and rejects missing values", () => {
    expect(parseCliArgs(["--profile", "writer"])).toMatchObject({
      args: { profile: "writer" },
    });
    expect(parseCliArgs(["--profile"])).toEqual({
      kind: "error",
      message: "--profile requires a profile name",
    });
    expect(parseCliArgs(["--profile", "-c"])).toMatchObject({ kind: "error" });
  });

  test("--continue and --resume set the resume target", () => {
    expect(parseCliArgs(["--continue"])).toMatchObject({
      args: { resume: "latest" },
    });
    expect(parseCliArgs(["-r", "ses_abc"])).toMatchObject({
      args: { resume: "ses_abc" },
    });
  });

  test("missing or flag-shaped values are errors, not silent misparses", () => {
    expect(parseCliArgs(["--resume"])).toEqual({
      kind: "error",
      message: "--resume requires a session id",
    });
    expect(parseCliArgs(["-r", "--model", "x"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["--model"])).toEqual({
      kind: "error",
      message: "--model requires a model id",
    });
    expect(parseCliArgs(["-m", "-c"])).toMatchObject({ kind: "error" });
  });

  test("help and unknown options", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--wat"])).toEqual({
      kind: "error",
      message: "unknown option: --wat",
    });
    // A second bare "acp" is not a valid option once the command is set.
    expect(parseCliArgs(["acp", "acp"])).toMatchObject({ kind: "error" });
  });

  test("usage names the default model and every documented flag", () => {
    const DEFAULT = "claude-opus-4-8";
    const text = usage(DEFAULT);
    expect(text).toContain("Usage: minerva");
    expect(text).toContain(DEFAULT);
    for (const flag of ["--continue", "--resume", "--model", "--help", "acp"]) {
      expect(text).toContain(flag);
    }
    for (const keyVar of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DASHSCOPE_API_KEY"]) {
      expect(text).toContain(keyVar);
    }
    expect(text).toContain("/config");
  });
});
